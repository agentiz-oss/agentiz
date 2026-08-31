import { Op } from 'sequelize';
import { AgentApprovalRequest, type AgentApprovalLink, type AgentApprovalStatus } from '../models/AgentApprovalRequest';
import { AgentProject } from '../models/AgentProject';
import { AgentRun } from '../models/AgentRun';
import { AgentTask } from '../models/AgentTask';
import { assertCan, type AccessActor } from '../lib/access/projectAccess';
import { PROJECT_TOKENS } from '../lib/access/tokens';
import { completeApprovalWait } from '../lib/workflow/engineBridge';
import { ActivityService } from './ActivityService';

/**
 * "Человек должен решить" — creating the request, deciding it, and closing it when the flow that
 * opened it goes away. One service, because all three touch the same two invariants:
 *
 * 1. **A waiting node has at most one pending request.** The engine may dispatch the same node
 *    twice (a rebind on startup, a retried transition), and two rows would mean two rows in
 *    somebody's inbox for one decision. `request()` is therefore find-or-create on
 *    `(workflowRunId, nodeId)` while pending.
 * 2. **The row is decided before the graph is told.** Completing the external node runs the rest
 *    of the graph synchronously — including the node that writes the remark into the task thread,
 *    which is what starts the next round. A row still `pending` at that moment would be a request
 *    a person can decide twice.
 *
 * Right to decide is a **project token**, resolved here and nowhere else: `assertCan(actor,
 * projectId, request.assigneeToken)`. `checkPermission` cannot answer it — role groups are
 * deliberately absent from `user.groups` — and the access graph answers a different question
 * ("which rows are visible"), inside adminizer, handing nothing back out.
 */

/** Carries the HTTP status a route should answer with, like ProjectAccessError does. */
export class ApprovalError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface ApprovalRequestInput {
  projectId: string;
  taskId?: string | null;
  workflowRunId?: string | null;
  nodeId?: string | null;
  runId?: string | null;
  assigneeUserId?: number | null;
  /** Defaults to `agentiz-approval-decide`; any project token is accepted. */
  assigneeToken?: string | null;
  title: string;
  message?: string | null;
  links?: AgentApprovalLink[] | null;
}

export interface ApprovalDecisionInput {
  approvalId: string;
  actor: AccessActor;
  decision: 'approved' | 'rejected';
  comment?: string | null;
}

/** Links are operator input (a node's config, an MCP call); keep only what is renderable. */
function sanitizeLinks(links: unknown): AgentApprovalLink[] | null {
  if (!Array.isArray(links)) return null;
  const kept = links
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const url = String((item as Record<string, unknown>).url ?? '').trim();
      if (!url) return null;
      const label = String((item as Record<string, unknown>).label ?? '').trim() || url;
      return { label: label.slice(0, 120), url: url.slice(0, 2000) };
    })
    .filter((item): item is AgentApprovalLink => item !== null);
  return kept.length > 0 ? kept.slice(0, 10) : null;
}

export class ApprovalService {
  /**
   * Open a request, or hand back the one this node already has open.
   *
   * The activity is recorded only for a genuinely new row — a re-dispatch must not notify twice —
   * and it is addressed by the request's own token, so the people who cannot decide it are not
   * woken by it.
   */
  static async request(input: ApprovalRequestInput): Promise<{ approval: AgentApprovalRequest; created: boolean }> {
    const project = await AgentProject.findByPk(input.projectId);
    if (!project) throw new ApprovalError(404, `Проект ${input.projectId} не найден`);

    const assigneeToken = (input.assigneeToken || PROJECT_TOKENS.approvalDecide).toLowerCase();

    if (input.workflowRunId && input.nodeId) {
      const existing = await AgentApprovalRequest.findOne({
        where: { workflowRunId: input.workflowRunId, nodeId: input.nodeId, status: 'pending' },
      });
      if (existing) return { approval: existing, created: false };
    }

    const approval = await AgentApprovalRequest.create({
      projectId: project.id,
      taskId: input.taskId ?? null,
      workflowRunId: input.workflowRunId ?? null,
      nodeId: input.nodeId ?? null,
      runId: input.runId ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
      assigneeToken,
      title: String(input.title || 'Требуется решение').slice(0, 250),
      message: input.message ?? null,
      links: sanitizeLinks(input.links),
      status: 'pending',
    });

    await ActivityService.record({
      type: 'approval.requested',
      projectId: approval.projectId,
      taskId: approval.taskId,
      runId: approval.runId,
      title: approval.title,
      body: approval.message ?? 'Откройте задачу и примите решение.',
      data: { approvalId: approval.id, links: approval.links ?? [], assigneeUserId: approval.assigneeUserId },
      // The decision reaches only the people who may make it. Everybody else learns about it from
      // the feed, which is written regardless of any policy or addressing.
      recipientToken: assigneeToken,
    });

    return { approval, created: true };
  }

  /**
   * The person's answer. Refuses anything already decided with 409 — a second tap on a stale
   * screen must not re-open a graph that has moved on.
   */
  static async decide(input: ApprovalDecisionInput): Promise<AgentApprovalRequest> {
    const approval = await AgentApprovalRequest.findByPk(input.approvalId);
    if (!approval) throw new ApprovalError(404, 'Заявка не найдена');
    await assertCan(input.actor, approval.projectId, approval.assigneeToken);
    if (approval.status !== 'pending') {
      throw new ApprovalError(409, `Заявка уже в статусе "${approval.status}"`);
    }

    const comment = typeof input.comment === 'string' ? input.comment.trim() : '';
    // A rejection without a reason is the one thing this whole loop exists to avoid: the text is
    // what the agent receives as its next instruction, and "отклонено" alone sends it to redo the
    // task from scratch.
    if (input.decision === 'rejected' && comment.length === 0) {
      throw new ApprovalError(400, 'Причина отказа обязательна — этот текст получит агент');
    }

    const decidedByUserId = actorUserId(input.actor);
    await approval.update({
      status: input.decision,
      decidedByUserId,
      decidedAt: new Date(),
      decisionComment: comment || null,
    });

    await ActivityService.record({
      type: 'approval.decided',
      projectId: approval.projectId,
      taskId: approval.taskId,
      runId: approval.runId,
      title: input.decision === 'approved' ? `Принято: ${approval.title}` : `Отклонено: ${approval.title}`,
      body: comment || (input.decision === 'approved' ? 'Работа принята.' : 'Работа отклонена.'),
      data: { approvalId: approval.id, decision: input.decision },
    });

    // Decided first, told second — see the class comment. Best-effort: a workflow that cannot be
    // continued must not undo a decision a person has already made.
    await completeApprovalWait(approval.id, {
      decision: input.decision,
      comment: comment || null,
      decidedByUserId,
      taskId: approval.taskId,
      projectId: approval.projectId,
      runId: approval.runId,
    });

    return approval;
  }

  /**
   * Close every request the given workflow run still holds open.
   *
   * Called when a flow reaches a terminal status (`lib/workflow/runStore.ts`). Without it a
   * cancelled or failed flow leaves a blocking row in somebody's inbox forever, waiting for a
   * graph that is not there any more — the "заявка-сирота" risk of the plan. Deliberately not
   * routed through `decide`: nobody decided anything, and no `approval.decided` is emitted.
   */
  static async cancelForWorkflowRun(workflowRunId: string): Promise<number> {
    if (!workflowRunId) return 0;
    const [count] = await AgentApprovalRequest.update(
      { status: 'cancelled', decidedAt: new Date() },
      { where: { workflowRunId, status: 'pending' } },
    );
    return count;
  }

  /** Everything still waiting, in the projects the caller may see. Oldest first: it is a queue. */
  static async listPending(
    projectIds: string[],
    options: { taskId?: string | null; limit?: number } = {},
  ): Promise<AgentApprovalRequest[]> {
    if (projectIds.length === 0) return [];
    return AgentApprovalRequest.findAll({
      where: {
        projectId: { [Op.in]: projectIds },
        status: 'pending',
        ...(options.taskId ? { taskId: options.taskId } : {}),
      },
      order: [['createdAt', 'ASC']],
      limit: Math.min(Math.max(Math.floor(options.limit ?? 200), 1), 500),
    });
  }

  /** The read model both the panel card and the mobile/MCP payloads are built from. */
  static async describe(approval: AgentApprovalRequest): Promise<Record<string, unknown>> {
    const [task, run] = await Promise.all([
      approval.taskId ? AgentTask.findByPk(approval.taskId) : Promise.resolve(null),
      approval.runId ? AgentRun.findByPk(approval.runId) : Promise.resolve(null),
    ]);
    return {
      id: approval.id,
      projectId: approval.projectId,
      taskId: approval.taskId,
      taskTitle: task?.title ?? null,
      workflowRunId: approval.workflowRunId,
      nodeId: approval.nodeId,
      runId: approval.runId,
      runStatus: run?.status ?? null,
      runVerdict: run?.verdict ?? null,
      runVerdictReason: run?.verdictReason ?? null,
      // Facts about the work, so a surface showing this request does not have to send the reader
      // looking for them: the branch it went to and the commit it produced.
      runBranch: run?.branch ?? null,
      runCommitSha: run?.commitSha ?? null,
      runCommitUrl: run?.commitUrl ?? null,
      assigneeUserId: approval.assigneeUserId,
      assigneeToken: approval.assigneeToken,
      title: approval.title,
      message: approval.message,
      links: approval.links ?? [],
      status: approval.status,
      decidedByUserId: approval.decidedByUserId,
      decidedAt: approval.decidedAt,
      decisionComment: approval.decisionComment,
      createdAt: approval.createdAt,
      updatedAt: approval.updatedAt,
    };
  }
}

export function isApprovalStatus(value: unknown): value is AgentApprovalStatus {
  return typeof value === 'string'
    && ['pending', 'approved', 'rejected', 'cancelled', 'expired'].includes(value);
}

function actorUserId(actor: AccessActor): number | null {
  if (actor === null || actor === undefined) return null;
  const raw = typeof actor === 'object' ? actor.id : actor;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}
