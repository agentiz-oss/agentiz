import { Op } from 'sequelize';
import { AgentActivity } from '../../app-agentiz/models/AgentActivity';
import { AgentActivitySeen } from '../../app-agentiz/models/AgentActivitySeen';
import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { AgentRun } from '../../app-agentiz/models/AgentRun';
import { AgentTask } from '../../app-agentiz/models/AgentTask';
import { effectiveActivityPolicy } from '../../app-agentiz/lib/notifications/policySettings';
import { MobileInboxDismissal } from '../models/MobileInboxDismissal';
import { MobileAuthError } from './MobileAuthService';
import { visibleProjectIds } from '../lib/mobileScope';
import {
  applyDismissal,
  collectInboxItems,
  collectRunInboxItems,
  collectTaskInboxItems,
  isBlockingInboxItem,
  sortInboxItems,
  workerAlerts,
  type InboxItem,
} from '../../app-agentiz/lib/inbox';

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
        workerAlerts: await workerAlerts(),
      };
    }

    // The rows themselves are the core's — the panel reads exactly the same ones. What stays here
    // is the *mobile* shape of the answer: the three legacy arrays, the dismissals and the
    // unseen-feed counter, none of which the panel has.
    const [collected, unseen] = await Promise.all([
      collectInboxItems({ projectIds, actor: ownerId }),
      this.unseenCount(ownerId, userId),
    ]);
    const { items: built, interactions, proposals, heldDiffs, taskById, runById } = collected;

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
      /**
       * Machines that need a person, riding the one request the app already polls.
       *
       * Deliberately **not** project-scoped, like the rest of the capacity surface: a worker
       * belongs to the installation, holds nothing secret (a name and a state, never a
       * credential), and a machine that cannot log in stops everybody's work, not one project's.
       * It is here rather than on `/workers` because the phone has to be able to *notice* it
       * without opening the workers screen — that was exactly the failure this whole state
       * answers: a queue that stopped moving with nothing anywhere saying so.
       */
      workerAlerts: await workerAlerts(),
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
   * Everything waiting on a person because of **one run**, minus what this reader has dismissed.
   *
   * The projection is the core's (`collectRunInboxItems`); what this adds is the reader, which is
   * a mobile-only idea — the panel has no dismissals.
   */
  static async itemsForRun(
    run: AgentRun,
    task: AgentTask | null,
    project: AgentProject | null,
    /** The reader, when known: their dismissed rows are hidden here as well as in the inbox. */
    userId?: number,
  ): Promise<InboxItem[]> {
    return this.visible(userId, await collectRunInboxItems(run, task, project));
  }

  /** Everything waiting on a person within one task — the "что дальше" strip on the task screen. */
  static async itemsForTask(
    task: AgentTask,
    project: AgentProject | null,
    userId?: number,
  ): Promise<InboxItem[]> {
    return this.visible(userId, await collectTaskInboxItems(task, project, userId));
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
