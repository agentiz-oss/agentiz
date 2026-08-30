import type { IMcpTool } from '@nodeknit/app-mcp';
import { Op } from 'sequelize';
import { AgentApprovalRequest } from '../models/AgentApprovalRequest';
import { ApprovalService } from '../services/ApprovalService';

/**
 * The human gate over MCP: read what is waiting on a person, and answer it.
 *
 * The MCP endpoint is authenticated by a machine key, not by a session, so there is no project
 * membership to check against — the caller is the deployment's operator by construction. That is
 * why the decision is made with an administrator-shaped actor and why `decidedByUserId` is an
 * explicit parameter: the row must still record *who* decided, and "an agent pressed it" is a
 * legitimate answer that has to be visible as such rather than attributed to nobody.
 *
 * `decideApproval` is deliberately state-changing (`agentiz-actions`) and `approvals` is not.
 */

type Params = Record<string, unknown>;

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;

function objectParams(params: unknown): Params {
  return params !== null && typeof params === 'object' && !Array.isArray(params) ? params as Params : {};
}

function stringParam(params: Params, name: string): string | undefined {
  const value = params[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requiredString(params: Params, name: string): string {
  const value = stringParam(params, name);
  if (!value) throw new Error(`${name}:string is required`);
  return value;
}

const approvalsTool: IMcpTool = {
  name: 'agentiz.approvals', group: 'agentiz',
  shortDescription: 'Lists approval requests — decisions a workflow is waiting on a person for.',
  description: 'Lists AgentApprovalRequest rows: the human gate of a workflow ("примите работу" / "лить ли в main"). A pending request parks a whole workflow run in waiting_external and is closed only by a decision (agentiz-actions.decideApproval) or by the flow being cancelled — nothing times it out. Defaults to status=pending, which is the only status that is holding anything. Not the same thing as agentiz.proposals: a proposal holds a worker directory and is about a diff, this is about whether the work itself is accepted.',
  mode: 'protected',
  inputSchema: {
    type: 'object',
    properties: {
      approvalId: { type: 'string' },
      projectId: { type: 'string' },
      taskId: { type: 'string' },
      workflowRunId: { type: 'string' },
      status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'cancelled', 'expired'], default: 'pending' },
      limit: { type: 'integer', default: LIMIT_DEFAULT, maximum: LIMIT_MAX },
    },
  },
  async handler(params) {
    const payload = objectParams(params);
    const approvalId = stringParam(payload, 'approvalId');
    const limit = Number.isFinite(Number(payload.limit))
      ? Math.min(Math.max(Math.floor(Number(payload.limit)), 1), LIMIT_MAX)
      : LIMIT_DEFAULT;
    const where = {
      ...(approvalId ? { id: approvalId } : {}),
      ...(stringParam(payload, 'projectId') ? { projectId: stringParam(payload, 'projectId') } : {}),
      ...(stringParam(payload, 'taskId') ? { taskId: stringParam(payload, 'taskId') } : {}),
      ...(stringParam(payload, 'workflowRunId') ? { workflowRunId: stringParam(payload, 'workflowRunId') } : {}),
      // An explicit id means "show me this one whatever it is": filtering it by status as well
      // would answer "not found" for a request that was decided a minute ago.
      ...(approvalId ? {} : { status: stringParam(payload, 'status') ?? 'pending' }),
    };
    const rows = await AgentApprovalRequest.findAll({
      where: where as Record<string, unknown> & { [Op.and]?: unknown },
      order: [['createdAt', 'ASC']],
      limit,
    });
    return {
      count: rows.length,
      items: await Promise.all(rows.map((row) => ApprovalService.describe(row))),
    };
  },
};

const decideApprovalTool: IMcpTool = {
  name: 'agentiz.decideApproval', group: 'agentiz-actions',
  shortDescription: 'Accepts or rejects an approval request, continuing the workflow that waits on it.',
  description: 'Answers a pending approval request and lets the parked workflow continue on its "approved" or "rejected" port. A rejection REQUIRES a comment: that text is handed to the agent as its next instruction, and "rejected" with no reason sends it to redo the task from scratch instead of fixing what is wrong. Refuses with 409 anything already decided — the graph has moved on. decidedByUserId records who made the call; pass the Adminizer user id of the person you are acting for when there is one.',
  mode: 'protected',
  inputSchema: {
    type: 'object',
    required: ['approvalId', 'decision'],
    properties: {
      approvalId: { type: 'string' },
      decision: { type: 'string', enum: ['approved', 'rejected'] },
      comment: { type: 'string', description: 'Required for "rejected": the remark the agent receives as its next task.' },
      decidedByUserId: { type: 'integer', description: 'Adminizer user id recorded as the decider. Omit when no person is behind the call.' },
    },
  },
  async handler(params) {
    const payload = objectParams(params);
    const approvalId = requiredString(payload, 'approvalId');
    const decision = requiredString(payload, 'decision');
    if (decision !== 'approved' && decision !== 'rejected') {
      throw new Error('decision must be "approved" or "rejected"');
    }
    const decidedByUserId = Number(payload.decidedByUserId ?? NaN);
    const approval = await ApprovalService.decide({
      approvalId,
      // The MCP key is the authorisation; `isAdministrator` is what says so to `assertCan`, which
      // otherwise looks for a project membership this caller does not have.
      actor: { id: Number.isFinite(decidedByUserId) ? decidedByUserId : null, isAdministrator: true },
      decision,
      comment: stringParam(payload, 'comment') ?? null,
    });
    return ApprovalService.describe(approval);
  },
};

export const agentizApprovalMcpTools: IMcpTool[] = [approvalsTool, decideApprovalTool];
