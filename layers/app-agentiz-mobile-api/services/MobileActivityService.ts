import { Op } from 'sequelize';
import { AgentActivity } from '../../app-agentiz/models/AgentActivity';
import { AgentStageExecution } from '../../app-agentiz/models/AgentStageExecution';
import { AgentActivitySeen } from '../../app-agentiz/models/AgentActivitySeen';
import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { AgentRun } from '../../app-agentiz/models/AgentRun';
import { AgentRunDiff } from '../../app-agentiz/models/AgentRunDiff';
import { AgentRunInteraction } from '../../app-agentiz/models/AgentRunInteraction';
import { AgentTask } from '../../app-agentiz/models/AgentTask';
import { AgentWorkspaceProposal } from '../../app-agentiz/models/AgentWorkspaceProposal';
import { AgentWorkspaceProposalService } from '../../app-agentiz/services/AgentWorkspaceProposalService';
import { effectiveActivityPolicy } from '../../app-agentiz/lib/notifications/policySettings';
import { MobileInboxDismissal } from '../models/MobileInboxDismissal';
import { MobileAuthError } from './MobileAuthService';
import { canInProject, visibleProjectIds } from '../lib/mobileScope';
import {
  applyDismissal,
  heldDiffItem,
  isBlockingInboxItem,
  proposalItem,
  pullRequestItem,
  questionItem,
  runFailureItem,
  sortInboxItems,
  type InboxItem,
} from '../lib/inboxItems';

const PAGE_LIMIT_DEFAULT = 50;
const PAGE_LIMIT_MAX = 200;

/**
 * How long a dismissal is kept.
 *
 * It only has to outlive the row it hides, and a row lives as long as its entity is the latest
 * failure of a task or an open PR. Ninety days is far past that for both, and the sweep keeps a
 * phone that dismisses a reminder a day from growing a table nobody ever reads.
 */
const DISMISSAL_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Proposal statuses a human has to act on — the same three the review screen shows buttons for. */
const ACTIONABLE_PROPOSAL_STATUSES = ['waiting_review', 'push_failed', 'reset_failed'] as const;

export interface ActivityListPage {
  items: Array<Record<string, unknown>>;
  /** Pass back as `before` for the next (older) page; null when this page reached the beginning. */
  nextBefore: string | null;
}

/**
 * The activity feed and the "требуют действия" summary, scoped like everything else in this API:
 * a person sees exactly the projects whose `ownerId` is theirs (see MobileInteractionService).
 *
 * The feed is the immutable journal (AgentActivity); "actionable now" is deliberately *not* read
 * from it — resolved/unresolved state lives on the live entities (pending interactions, proposals,
 * held diffs), and duplicating it into feed rows is what the design ruled out.
 */
export class MobileActivityService {
  /**
   * Projects the caller may look at — owned plus every project they hold a membership row in
   * (`lib/mobileScope.ts`). Empty means "nothing to look at", never "everything".
   */
  private static async ownedProjectIds(ownerId: number | string): Promise<string[]> {
    return visibleProjectIds(ownerId);
  }

  /**
   * One feed page, newest first, keyed by `(createdAt, id)` — the same cursor idea as the run log:
   * a feed only grows, and "the first N" would pin a reader to ever-older rows.
   */
  static async list(
    ownerId: number | string,
    options: { before?: string | null; limit?: number } = {},
  ): Promise<ActivityListPage> {
    const projectIds = await this.ownedProjectIds(ownerId);
    if (projectIds.length === 0) return { items: [], nextBefore: null };
    const limit = Math.min(Math.max(Math.floor(options.limit ?? PAGE_LIMIT_DEFAULT), 1), PAGE_LIMIT_MAX);

    const where: Record<string, unknown> = { projectId: { [Op.in]: projectIds } };
    const cursor = this.parseCursor(options.before);
    if (cursor) {
      Object.assign(where, {
        [Op.or]: [
          { createdAt: { [Op.lt]: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { [Op.lt]: cursor.id } },
        ],
      });
    }

    const rows = await AgentActivity.findAll({
      where,
      order: [['createdAt', 'DESC'], ['id', 'DESC']],
      limit,
    });

    const [projects, tasks] = await Promise.all([
      AgentProject.findAll({ where: { id: { [Op.in]: [...new Set(rows.map((row) => row.projectId))] } } }),
      AgentTask.findAll({ where: { id: { [Op.in]: [...new Set(rows.map((row) => row.taskId).filter(Boolean))] as string[] } } }),
    ]);
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const taskById = new Map(tasks.map((task) => [task.id, task]));

    const items = rows.map((row) => ({
      id: row.id,
      type: row.type,
      kind: row.kind,
      projectId: row.projectId,
      projectName: projectById.get(row.projectId)?.name ?? null,
      runId: row.runId,
      taskId: row.taskId,
      taskTitle: row.taskId ? taskById.get(row.taskId)?.title ?? null : null,
      proposalId: row.proposalId,
      interactionId: row.interactionId,
      title: row.title,
      body: row.body,
      data: row.data,
      createdAt: row.createdAt,
    }));

    const last = rows[rows.length - 1];
    return {
      items,
      nextBefore: rows.length === limit && last ? this.cursorOf(last) : null,
    };
  }

  /** "Ленту видел до момента X" — one mark per user, moving forward only. */
  static async markSeen(userId: number, at?: Date): Promise<{ seenAt: Date }> {
    const seenAt = at && !Number.isNaN(at.getTime()) ? at : new Date();
    const existing = await AgentActivitySeen.findByPk(userId);
    if (!existing) {
      await AgentActivitySeen.create({ userId, seenAt });
      return { seenAt };
    }
    // Never move the mark back: two racing clients must not resurrect a badge already cleared.
    if (existing.seenAt.getTime() < seenAt.getTime()) await existing.update({ seenAt });
    return { seenAt: existing.seenAt.getTime() < seenAt.getTime() ? seenAt : existing.seenAt };
  }

  static async unseenCount(ownerId: number | string, userId: number): Promise<number> {
    const projectIds = await this.ownedProjectIds(ownerId);
    if (projectIds.length === 0) return 0;
    const seen = await AgentActivitySeen.findByPk(userId);
    return AgentActivity.count({
      where: {
        projectId: { [Op.in]: projectIds },
        ...(seen ? { createdAt: { [Op.gt]: seen.seenAt } } : {}),
      },
    });
  }

  /**
   * Everything waiting on the caller *right now*, computed from live entities: pending questions,
   * proposals somebody has to approve/reject/retry, and repository runs whose diff `requireApproval`
   * holds back. Plus the unseen-feed counter, so the app needs one request, not four.
   */
  static async summary(
    ownerId: number | string,
    userId: number,
    options: { includeDismissed?: boolean } = {},
  ) {
    const projectIds = await this.ownedProjectIds(ownerId);
    if (projectIds.length === 0) {
      return {
        items: [], interactions: [], proposals: [], heldRuns: [],
        actionableCount: 0, dismissedCount: 0, unseen: 0,
      };
    }

    const [interactions, proposals, heldDiffs, openedPrs, failedTasks, unseen] = await Promise.all([
      AgentRunInteraction.findAll({
        where: { projectId: { [Op.in]: projectIds }, status: 'pending' },
        order: [['createdAt', 'ASC']],
        limit: 200,
      }),
      AgentWorkspaceProposal.findAll({
        where: { projectId: { [Op.in]: projectIds }, status: { [Op.in]: [...ACTIONABLE_PROPOSAL_STATUSES] } },
        order: [['updatedAt', 'DESC']],
        limit: 200,
      }),
      this.heldDiffs(projectIds),
      // `pr.opened` is `action_required` in the catalogue but has no live entity of its own — see
      // openPullRequests for what makes one of these go away.
      AgentActivity.findAll({
        where: { projectId: { [Op.in]: projectIds }, type: 'pr.opened' },
        order: [['createdAt', 'DESC']],
        limit: 100,
      }),
      // A failed run leaves its task in `failed` and a re-run moves it out again (queued →
      // running), so this status *is* "последняя попытка упала и с тех пор никто ничего не сделал"
      // — one row per stuck task instead of one per failed attempt, without ranking runs here.
      AgentTask.findAll({
        where: { projectId: { [Op.in]: projectIds }, status: 'failed' },
        order: [['updatedAt', 'DESC']],
        limit: 100,
      }),
      this.unseenCount(ownerId, userId),
    ]);

    const failedRuns = await this.latestRunPerTask(failedTasks.map((task) => task.id));

    const runIds = new Set<string>([
      ...interactions.map((item) => item.runId),
      ...proposals.map((item) => item.latestRunId),
      ...heldDiffs.map((item) => item.diff.runId),
      ...openedPrs.map((row) => row.runId).filter(Boolean) as string[],
    ]);
    const [runs, projects, stages, diffs] = await Promise.all([
      AgentRun.findAll({ where: { id: { [Op.in]: [...runIds] } } }),
      AgentProject.findAll({ where: { id: { [Op.in]: projectIds } } }),
      // Only to name the stage a question came from: "этап implement" is what tells a reader which
      // half of the pipeline is parked.
      AgentStageExecution.findAll({
        where: { id: { [Op.in]: [...new Set(interactions.map((item) => item.stageExecutionId).filter(Boolean))] as string[] } },
      }),
      AgentRunDiff.findAll({
        where: { id: { [Op.in]: [...new Set(proposals.map((item) => item.latestDiffId).filter(Boolean))] as string[] } },
      }),
    ]);
    const runById = new Map(runs.map((run) => [run.id, run]));
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const stageById = new Map(stages.map((stage) => [stage.id, stage]));
    const diffById = new Map(diffs.map((diff) => [diff.id, diff]));

    const taskIds = new Set<string>([
      ...proposals.map((item) => item.taskId),
      ...[...runById.values()].map((run) => run.taskId),
      ...openedPrs.map((row) => row.taskId).filter(Boolean) as string[],
    ]);
    const tasks = await AgentTask.findAll({ where: { id: { [Op.in]: [...taskIds] } } });
    const taskById = new Map([...tasks, ...failedTasks].map((task) => [task.id, task]));
    // The pipeline goes into the context for one reason: the notification policy resolves
    // `pipelines[specId]` before the project scope, so a row that skipped it could tell a reader
    // "пуш включён" about an event their pipeline rule had switched off.
    const contextOf = (projectId: string, taskId: string | null | undefined, pipelineSpecId?: string | null) => ({
      project: projectById.get(projectId) ?? null,
      task: taskId ? taskById.get(taskId) ?? null : null,
      pipelineSpecId: pipelineSpecId ?? null,
    });

    const interactionRows = interactions.map((item) => ({
      id: item.id,
      runId: item.runId,
      projectId: item.projectId,
      taskId: runById.get(item.runId)?.taskId ?? null,
      taskTitle: taskById.get(runById.get(item.runId)?.taskId ?? '')?.title ?? null,
      message: item.message,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
    }));
    const proposalRows = proposals.map((item) => ({
      id: item.id,
      status: item.status,
      revision: item.revision,
      projectId: item.projectId,
      taskId: item.taskId,
      taskTitle: taskById.get(item.taskId)?.title ?? null,
      runId: item.latestRunId,
      targetBranch: item.targetBranch,
      commitMessage: item.commitMessage,
      lastError: item.lastError,
      updatedAt: item.updatedAt,
    }));
    const heldRunRows = heldDiffs.map(({ diff, run }) => ({
      runId: run.id,
      projectId: run.projectId,
      taskId: run.taskId,
      taskTitle: taskById.get(run.taskId)?.title ?? null,
      diffId: diff.id,
      operations: diff.ops?.length ?? 0,
      finishedAt: run.finishedAt,
    }));

    const built = sortInboxItems([
      ...interactions.map((item) => questionItem(item, {
        ...contextOf(item.projectId, runById.get(item.runId)?.taskId, runById.get(item.runId)?.pipelineSpecId),
        run: runById.get(item.runId) ?? null,
        stageRole: item.stageExecutionId ? stageById.get(item.stageExecutionId)?.role ?? null : null,
      })),
      ...proposals.map((item) => {
        const diff = item.latestDiffId ? diffById.get(item.latestDiffId) ?? null : null;
        return proposalItem(item, {
          ...contextOf(item.projectId, item.taskId, runById.get(item.latestRunId)?.pipelineSpecId),
          diff,
          approvable: AgentWorkspaceProposalService.isApprovableDiff(diff),
        });
      }),
      ...heldDiffs.map(({ diff, run }) => heldDiffItem(diff, run, contextOf(run.projectId, run.taskId, run.pipelineSpecId))),
      // A stuck task is only actionable while its proposal is not: an unapprovable proposal on the
      // same run already says "освободите папку", and two rows for one dead end read as two.
      ...failedTasks.flatMap((task) => {
        const run = failedRuns.get(task.id);
        if (!run || proposals.some((proposal) => proposal.taskId === task.id)) return [];
        return [runFailureItem(run, contextOf(task.projectId, task.id, run.pipelineSpecId))];
      }),
      ...this.openPullRequests(openedPrs, taskById).map((row) => pullRequestItem({
        id: row.id,
        projectId: row.projectId,
        url: typeof (row.data as any)?.prUrl === 'string' ? (row.data as any).prUrl : row.body,
        createdAt: row.createdAt,
        runId: row.runId,
      }, contextOf(row.projectId, row.taskId, row.runId ? runById.get(row.runId)?.pipelineSpecId : null))),
    ]);

    // What the reader has already read and waved through. Dismissed rows are dropped rather than
    // greyed out — «я этим не занимаюсь» means gone from the list — but they are still counted, so
    // the screen can offer to show them again instead of losing them silently.
    const decided = await this.withDismissals(userId, built);
    const dismissedCount = decided.filter((item) => item.dismissedAt).length;
    const items = options.includeDismissed
      ? sortInboxItems(decided)
      : decided.filter((item) => !item.dismissedAt);

    return {
      /**
       * The one list the inbox renders. The three arrays below it are the same facts in the shape
       * older builds parse — they stay until those builds are gone, and neither side is derived
       * from the other by the client.
       */
      items,
      interactions: interactionRows,
      proposals: proposalRows,
      heldRuns: heldRunRows,
      /**
       * Only what actually holds something. A pull request and a dead run are shown in the list
       * but not counted: nothing local ever resolves them, so counting them would grow the number
       * forever until "12 требуют действия" stopped meaning anything at all.
       */
      actionableCount: items.filter(isBlockingInboxItem).length,
      /** How many rows this caller has hidden — the "Скрытые (N)" switch, nothing else. */
      dismissedCount,
      unseen,
    };
  }

  /**
   * "Прочитал, разбираться не буду" — the only way a reminder ever leaves this list.
   *
   * Deliberately narrow. It records **one person's** decision about **one row**, and it is refused
   * for anything blocking: a review, a question or a failed push holds a real resource, hiding it
   * would leave the next run failing on a reservation whose explanation is no longer on screen,
   * and those already have an exit (answer, approve, reject, release). The row must also currently
   * be in the caller's own inbox — that is what makes a foreign id a 404 here, like everywhere else
   * in this API, and it means the stored row is always one the caller could see.
   *
   * Nothing else moves: the task keeps its status, the tracker is not touched and the activity feed
   * keeps its entry. A run that fails again is a new run, a new row id and a new row.
   */
  static async dismiss(ownerId: number | string, userId: number, itemId: string) {
    const item = await this.findOwnItem(ownerId, userId, itemId);
    if (!item.dismissible) {
      throw new MobileAuthError(
        409,
        'Эту строку нельзя просто скрыть: она держит воркер или изменения. Решите её кнопками на карточке.',
      );
    }
    const dismissedAt = new Date();
    const [row, created] = await MobileInboxDismissal.findOrCreate({
      where: { userId, itemId },
      defaults: {
        userId,
        itemId,
        projectId: item.projectId,
        taskId: item.taskId,
        runId: item.runId,
        activityType: item.activityType,
        dismissedAt,
      },
    });
    // Dismissing twice is the same statement, not a second one — keep the original moment.
    await this.pruneDismissals(userId);
    return { item: applyDismissal(item, created ? dismissedAt : row.dismissedAt), dismissed: true };
  }

  /** The undo. Absent row = already back in the list, which is the state the caller asked for. */
  static async restore(ownerId: number | string, userId: number, itemId: string) {
    const item = await this.findOwnItem(ownerId, userId, itemId, { includeDismissed: true });
    await MobileInboxDismissal.destroy({ where: { userId, itemId } });
    return { item: applyDismissal({ ...item, dismissedAt: null }, null), dismissed: false };
  }

  /** The caller's own row by id, or a 404 — the ownership check both writes above share. */
  private static async findOwnItem(
    ownerId: number | string,
    userId: number,
    itemId: string,
    options: { includeDismissed?: boolean } = {},
  ): Promise<InboxItem> {
    const summary = await this.summary(ownerId, userId, { includeDismissed: options.includeDismissed ?? true });
    const item = summary.items.find((row) => row.id === itemId);
    if (!item) throw new MobileAuthError(404, 'Inbox item not found');
    // Returned as the builders wrote it: applyDismissal is what the callers put back on top.
    return { ...item, dismissedAt: null };
  }

  /** Marks each row with this caller's dismissal, in one query for the whole list. */
  private static async withDismissals(userId: number, items: InboxItem[]): Promise<InboxItem[]> {
    const dismissible = items.filter((item) => item.dismissible).map((item) => item.id);
    if (dismissible.length === 0) return items;
    const rows = await MobileInboxDismissal.findAll({
      where: { userId, itemId: { [Op.in]: dismissible } },
    });
    const byItem = new Map(rows.map((row) => [row.itemId, row.dismissedAt]));
    return items.map((item) => applyDismissal(item, byItem.get(item.id) ?? null));
  }

  /** Drops this caller's dismissals older than the TTL. Cheap, and only on a write. */
  private static async pruneDismissals(userId: number): Promise<void> {
    await MobileInboxDismissal.destroy({
      where: { userId, dismissedAt: { [Op.lt]: new Date(Date.now() - DISMISSAL_TTL_MS) } },
    });
  }

  /**
   * PR rows that still deserve a person's attention.
   *
   * A pull request is the one actionable event whose resolution happens outside Agentiz — nothing
   * here learns that it was merged. Its stand-in is the task: closing the task is what a person
   * does after the PR is dealt with, so an `open` task with an opened PR keeps the row and a
   * done/cancelled/ignored one drops it. A task that never gets closed keeps a visible PR, which is
   * the honest reading of "никто на него не посмотрел".
   */
  private static openPullRequests(rows: AgentActivity[], taskById: Map<string, AgentTask>): AgentActivity[] {
    const closed = new Set(['done', 'cancelled', 'ignored']);
    const seenRuns = new Set<string>();
    return rows.filter((row) => {
      const task = row.taskId ? taskById.get(row.taskId) : null;
      if (!task || closed.has(task.status)) return false;
      // One row per run: a re-opened PR for the same run is the same thing to look at.
      const key = row.runId ?? row.id;
      if (seenRuns.has(key)) return false;
      seenRuns.add(key);
      return true;
    });
  }

  /**
   * The newest run of each of the given tasks, in one query.
   *
   * Sorted client-side rather than with a window function: sqlite and postgres are both supported
   * deployments here, and the caller's list is bounded (the failed tasks of one owner).
   */
  private static async latestRunPerTask(taskIds: string[]): Promise<Map<string, AgentRun>> {
    if (taskIds.length === 0) return new Map();
    const runs = await AgentRun.findAll({
      where: { taskId: { [Op.in]: taskIds } },
      order: [['createdAt', 'DESC']],
    });
    const byTask = new Map<string, AgentRun>();
    for (const run of runs) if (!byTask.has(run.taskId)) byTask.set(run.taskId, run);
    return byTask;
  }

  /**
   * Everything waiting on a person because of **one run** — what the run screen puts above its own
   * result, so that a run somebody opened from a notification states what to do about itself
   * instead of leaving the reader to work it out from a status word and a log.
   *
   * Same projection as the inbox, narrowed to this run: its pending questions, the proposal it
   * produced, a diff `requireApproval` held back, and the run's own failure when nothing else has
   * happened on the task since.
   */
  static async itemsForRun(
    run: AgentRun,
    task: AgentTask | null,
    project: AgentProject | null,
    /** The reader, when known: their dismissed rows are hidden here as well as in the inbox. */
    userId?: number,
  ): Promise<InboxItem[]> {
    const [interactions, proposal, held] = await Promise.all([
      AgentRunInteraction.findAll({ where: { runId: run.id, status: 'pending' }, order: [['createdAt', 'ASC']] }),
      AgentWorkspaceProposal.findOne({
        where: { latestRunId: run.id, status: { [Op.in]: [...ACTIONABLE_PROPOSAL_STATUSES] } },
      }),
      this.heldDiffs([run.projectId]),
    ]);
    const [stages, diff] = await Promise.all([
      AgentStageExecution.findAll({
        where: { id: { [Op.in]: [...new Set(interactions.map((item) => item.stageExecutionId).filter(Boolean))] as string[] } },
      }),
      proposal?.latestDiffId ? AgentRunDiff.findByPk(proposal.latestDiffId) : Promise.resolve(null),
    ]);
    const stageById = new Map(stages.map((stage) => [stage.id, stage]));
    const context = { task: task ?? null, project, pipelineSpecId: run.pipelineSpecId ?? null };

    // "Открыть запуск" is the reader's current location here, so it is dropped rather than drawn as
    // a button that does nothing. Everything else is the same projection the inbox renders.
    const here = (items: InboxItem[]) => items.map((item) => ({
      ...item,
      actions: item.actions.filter((action) => action.key !== 'open_run'),
    }));

    return this.visible(userId, here(sortInboxItems([
      ...interactions.map((item) => questionItem(item, {
        ...context,
        run,
        stageRole: item.stageExecutionId ? stageById.get(item.stageExecutionId)?.role ?? null : null,
      })),
      ...(proposal
        ? [proposalItem(proposal, {
            ...context,
            diff,
            approvable: AgentWorkspaceProposalService.isApprovableDiff(diff),
          })]
        : []),
      ...held.filter((entry) => entry.diff.runId === run.id).map((entry) => heldDiffItem(entry.diff, entry.run, context)),
      // Only when the task is still sitting on this failure: a task re-run since then is out of
      // `failed`, and offering "запустить ещё раз" on an old attempt would compete with it.
      ...(!proposal && run.status === 'failed' && task?.status === 'failed' ? [runFailureItem(run, context)] : []),
    ])));
  }

  /** Everything waiting on a person within one task — the "что дальше" strip on the task screen. */
  static async itemsForTask(
    task: AgentTask,
    project: AgentProject | null,
    userId?: number,
  ): Promise<InboxItem[]> {
    const [interactions, proposals, runs] = await Promise.all([
      AgentRunInteraction.findAll({ where: { projectId: task.projectId, status: 'pending' }, order: [['createdAt', 'ASC']] }),
      AgentWorkspaceProposal.findAll({
        where: { taskId: task.id, status: { [Op.in]: [...ACTIONABLE_PROPOSAL_STATUSES] } },
        order: [['updatedAt', 'DESC']],
      }),
      AgentRun.findAll({ where: { taskId: task.id }, attributes: ['id', 'pipelineSpecId'] }),
    ]);
    const runIds = new Set(runs.map((run) => run.id));
    const pipelineOfRun = new Map(runs.map((run) => [run.id, run.pipelineSpecId ?? null]));
    const ownInteractions = interactions.filter((item) => runIds.has(item.runId));

    const [stages, diffs, held] = await Promise.all([
      AgentStageExecution.findAll({
        where: { id: { [Op.in]: [...new Set(ownInteractions.map((item) => item.stageExecutionId).filter(Boolean))] as string[] } },
      }),
      AgentRunDiff.findAll({
        where: { id: { [Op.in]: [...new Set(proposals.map((item) => item.latestDiffId).filter(Boolean))] as string[] } },
      }),
      this.heldDiffs([task.projectId]),
    ]);
    const stageById = new Map(stages.map((stage) => [stage.id, stage]));
    const diffById = new Map(diffs.map((diff) => [diff.id, diff]));
    // One task can hold rows from runs of different pipelines, so the policy scope is per row.
    const context = (pipelineSpecId?: string | null) => ({ task, project, pipelineSpecId: pipelineSpecId ?? null });

    const latestRun = task.status === 'failed' && proposals.length === 0
      ? (await this.latestRunPerTask([task.id])).get(task.id) ?? null
      : null;

    return this.visible(userId, sortInboxItems([
      ...ownInteractions.map((item) => questionItem(item, {
        ...context(pipelineOfRun.get(item.runId)),
        stageRole: item.stageExecutionId ? stageById.get(item.stageExecutionId)?.role ?? null : null,
      })),
      ...(latestRun ? [runFailureItem(latestRun, context(latestRun.pipelineSpecId))] : []),
      ...proposals.map((item) => {
        const diff = item.latestDiffId ? diffById.get(item.latestDiffId) ?? null : null;
        return proposalItem(item, {
          ...context(pipelineOfRun.get(item.latestRunId)),
          diff,
          approvable: AgentWorkspaceProposalService.isApprovableDiff(diff),
        });
      }),
      ...held.filter(({ run }) => run.taskId === task.id)
        .map(({ diff, run }) => heldDiffItem(diff, run, context(run.pipelineSpecId))),
    ]));
  }

  /**
   * The same list minus what this reader has dismissed.
   *
   * A task's and a run's own screens hide dismissed rows too: a row waved away in the inbox that
   * kept reappearing one screen deeper would read as the dismissal not having worked. Without a
   * `userId` (an older caller) nothing is hidden — the pre-existing behaviour.
   */
  private static async visible(userId: number | undefined, items: InboxItem[]): Promise<InboxItem[]> {
    if (userId === undefined) return items;
    const decided = await this.withDismissals(userId, items);
    return decided.filter((item) => !item.dismissedAt);
  }

  /**
   * The number for the app icon badge: actionable items, minus anything whose type the owner
   * muted for push in that project — a mute means "не дёргай", so it must not keep a badge lit
   * either. Checked at project scope: the badge is per person, not per run, and walking every
   * run's pipeline scope here would be four queries for a corner nobody configured.
   */
  static async badgeCount(userId: number): Promise<number> {
    const summary = await this.summary(userId, userId);
    // Same two rules as the count above it: only what holds something, minus what the policy mutes
    // for push in that project — a mute means "не дёргай", so it must not keep a badge lit either.
    return summary.items
      .filter(isBlockingInboxItem)
      .filter((item) => effectiveActivityPolicy(item.activityType, item.projectId).push !== 'off')
      .length;
  }

  /** Diffs `requireApproval` parked in Agentiz: stored, never applied, from a succeeded repository run. */
  private static async heldDiffs(projectIds: string[]): Promise<Array<{ diff: AgentRunDiff; run: AgentRun }>> {
    const diffs = await AgentRunDiff.findAll({
      where: { projectId: { [Op.in]: projectIds }, appliedAt: null, proposalId: null },
      order: [['createdAt', 'DESC']],
      limit: 200,
    });
    if (diffs.length === 0) return [];
    const runs = await AgentRun.findAll({ where: { id: { [Op.in]: diffs.map((diff) => diff.runId) } } });
    const runById = new Map(runs.map((run) => [run.id, run]));
    return diffs.flatMap((diff) => {
      const run = runById.get(diff.runId);
      if (!run || run.status !== 'succeeded') return [];
      const action = run.pipelineSnapshot?.finalAction;
      if (action?.requireApproval !== true) return [];
      return [{ diff, run }];
    });
  }

  private static cursorOf(row: AgentActivity): string {
    return `${row.createdAt.getTime()}:${row.id}`;
  }

  private static parseCursor(before: string | null | undefined): { createdAt: Date; id: string } | null {
    if (!before) return null;
    const separator = before.indexOf(':');
    if (separator <= 0) return null;
    const time = Number(before.slice(0, separator));
    const id = before.slice(separator + 1);
    if (!Number.isFinite(time) || !id) return null;
    return { createdAt: new Date(time), id };
  }
}
