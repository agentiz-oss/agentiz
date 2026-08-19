import { Op } from 'sequelize';
import { AgentActivity } from '../../app-agentiz/models/AgentActivity';
import { AgentActivitySeen } from '../../app-agentiz/models/AgentActivitySeen';
import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { AgentRun } from '../../app-agentiz/models/AgentRun';
import { AgentRunDiff } from '../../app-agentiz/models/AgentRunDiff';
import { AgentRunInteraction } from '../../app-agentiz/models/AgentRunInteraction';
import { AgentTask } from '../../app-agentiz/models/AgentTask';
import { AgentWorkspaceProposal } from '../../app-agentiz/models/AgentWorkspaceProposal';
import { effectiveActivityPolicy } from '../../app-agentiz/lib/notifications/policySettings';

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
      return { interactions: [], proposals: [], heldRuns: [], actionableCount: 0, unseen: 0 };
    }

    const [interactions, proposals, heldDiffs, unseen] = await Promise.all([
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
      this.unseenCount(ownerId, userId),
    ]);

    const runIds = new Set<string>([
      ...interactions.map((item) => item.runId),
      ...proposals.map((item) => item.latestRunId),
      ...heldDiffs.map((item) => item.diff.runId),
    ]);
    const runs = await AgentRun.findAll({ where: { id: { [Op.in]: [...runIds] } } });
    const runById = new Map(runs.map((run) => [run.id, run]));
    const taskIds = new Set<string>([
      ...proposals.map((item) => item.taskId),
      ...[...runById.values()].map((run) => run.taskId),
    ]);
    const tasks = await AgentTask.findAll({ where: { id: { [Op.in]: [...taskIds] } } });
    const taskById = new Map(tasks.map((task) => [task.id, task]));

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

    return {
      interactions: interactionRows,
      proposals: proposalRows,
      heldRuns: heldRunRows,
      actionableCount: interactionRows.length + proposalRows.length + heldRunRows.length,
      unseen,
    };
  }

  /**
   * The number for the app icon badge: actionable items, minus anything whose type the owner
   * muted for push in that project — a mute means "не дёргай", so it must not keep a badge lit
   * either. Checked at project scope: the badge is per person, not per run, and walking every
   * run's pipeline scope here would be four queries for a corner nobody configured.
   */
  static async badgeCount(userId: number): Promise<number> {
    const summary = await this.summary(userId, userId);
    const allowed = (type: string, projectId: string) => effectiveActivityPolicy(type, projectId).push !== 'off';
    const proposalType = (status: string) => (status === 'waiting_review' ? 'proposal.waiting_review'
      : status === 'push_failed' ? 'proposal.push_failed' : 'proposal.reset_failed');
    return summary.interactions.filter((row) => allowed('interaction.created', row.projectId)).length
      + summary.proposals.filter((row) => allowed(proposalType(row.status), row.projectId)).length
      + summary.heldRuns.filter((row) => allowed('run.held_for_approval', row.projectId)).length;
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
