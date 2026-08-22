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
import {
  heldDiffItem,
  proposalItem,
  pullRequestItem,
  questionItem,
  sortInboxItems,
  type InboxItem,
} from '../lib/inboxItems';

const PAGE_LIMIT_DEFAULT = 50;
const PAGE_LIMIT_MAX = 200;

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
  /** Ids of the projects the caller owns. Empty means "nothing to look at", never "everything". */
  private static async ownedProjectIds(ownerId: number | string): Promise<string[]> {
    const projects = await AgentProject.findAll({ where: { ownerId: ownerId as any }, attributes: ['id'] });
    return projects.map((project) => project.id);
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
  static async summary(ownerId: number | string, userId: number) {
    const projectIds = await this.ownedProjectIds(ownerId);
    if (projectIds.length === 0) {
      return { items: [], interactions: [], proposals: [], heldRuns: [], actionableCount: 0, unseen: 0 };
    }

    const [interactions, proposals, heldDiffs, openedPrs, unseen] = await Promise.all([
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
      this.unseenCount(ownerId, userId),
    ]);

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
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const contextOf = (projectId: string, taskId: string | null | undefined) => ({
      project: projectById.get(projectId) ?? null,
      task: taskId ? taskById.get(taskId) ?? null : null,
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

    const items = sortInboxItems([
      ...interactions.map((item) => questionItem(item, {
        ...contextOf(item.projectId, runById.get(item.runId)?.taskId),
        run: runById.get(item.runId) ?? null,
        stageRole: item.stageExecutionId ? stageById.get(item.stageExecutionId)?.role ?? null : null,
      })),
      ...proposals.map((item) => {
        const diff = item.latestDiffId ? diffById.get(item.latestDiffId) ?? null : null;
        return proposalItem(item, {
          ...contextOf(item.projectId, item.taskId),
          diff,
          approvable: AgentWorkspaceProposalService.isApprovableDiff(diff),
        });
      }),
      ...heldDiffs.map(({ diff, run }) => heldDiffItem(diff, run, contextOf(run.projectId, run.taskId))),
      ...this.openPullRequests(openedPrs, taskById).map((row) => pullRequestItem({
        id: row.id,
        projectId: row.projectId,
        url: typeof (row.data as any)?.prUrl === 'string' ? (row.data as any).prUrl : row.body,
        createdAt: row.createdAt,
        runId: row.runId,
      }, contextOf(row.projectId, row.taskId))),
    ]);

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
      actionableCount: items.length,
      unseen,
    };
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

  /** Everything waiting on a person within one task — the "что дальше" strip on the task screen. */
  static async itemsForTask(task: AgentTask, project: AgentProject | null): Promise<InboxItem[]> {
    const [interactions, proposals, runs] = await Promise.all([
      AgentRunInteraction.findAll({ where: { projectId: task.projectId, status: 'pending' }, order: [['createdAt', 'ASC']] }),
      AgentWorkspaceProposal.findAll({
        where: { taskId: task.id, status: { [Op.in]: [...ACTIONABLE_PROPOSAL_STATUSES] } },
        order: [['updatedAt', 'DESC']],
      }),
      AgentRun.findAll({ where: { taskId: task.id }, attributes: ['id'] }),
    ]);
    const runIds = new Set(runs.map((run) => run.id));
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
    const context = { task, project };

    return sortInboxItems([
      ...ownInteractions.map((item) => questionItem(item, {
        ...context,
        stageRole: item.stageExecutionId ? stageById.get(item.stageExecutionId)?.role ?? null : null,
      })),
      ...proposals.map((item) => {
        const diff = item.latestDiffId ? diffById.get(item.latestDiffId) ?? null : null;
        return proposalItem(item, { ...context, diff, approvable: AgentWorkspaceProposalService.isApprovableDiff(diff) });
      }),
      ...held.filter(({ run }) => run.taskId === task.id).map(({ diff, run }) => heldDiffItem(diff, run, context)),
    ]);
  }

  /**
   * The number for the app icon badge: actionable items, minus anything whose type the owner
   * muted for push in that project — a mute means "не дёргай", so it must not keep a badge lit
   * either. Checked at project scope: the badge is per person, not per run, and walking every
   * run's pipeline scope here would be four queries for a corner nobody configured.
   */
  static async badgeCount(userId: number): Promise<number> {
    const summary = await this.summary(userId, userId);
    // One rule for every kind now that every kind is one shape: the item names its catalogue type,
    // and a type muted for push in that project must not keep a badge lit either.
    return summary.items.filter((item) => effectiveActivityPolicy(item.activityType, item.projectId).push !== 'off').length;
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
