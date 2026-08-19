import type { IMcpTool } from '@nodeknit/app-mcp';
import { Op } from 'sequelize';
import { AgentRunDiff } from '../models/AgentRunDiff';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentWorkspaceProposal } from '../models/AgentWorkspaceProposal';
import { AgentWorkspaceProposalService } from '../services/AgentWorkspaceProposalService';

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

function limitParam(params: Params): number {
  const value = typeof params.limit === 'number' ? params.limit : Number(params.limit ?? LIMIT_DEFAULT);
  return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 1), LIMIT_MAX) : LIMIT_DEFAULT;
}

/**
 * A proposal is the only thing that can hold a worker directory, so the teaser leads with the
 * reservation: `reservationKey` non-null is exactly the state that makes every further run on that
 * path fail, and `workspacePath` is the directory it is holding.
 */
function proposalTeaser(proposal: AgentWorkspaceProposal, diff: AgentRunDiff | null | undefined) {
  return {
    id: proposal.id, projectId: proposal.projectId, taskId: proposal.taskId,
    status: proposal.status, revision: proposal.revision,
    workerId: proposal.workerId, workspaceKey: proposal.workspaceKey, workspacePath: proposal.workspacePath,
    /** Non-null means this proposal is holding the directory; nothing else may run there. */
    reservationKey: proposal.reservationKey,
    holdsWorkspace: proposal.reservationKey !== null,
    repositoryId: proposal.repositoryId,
    baseSha: proposal.baseSha, baseBranch: proposal.baseBranch,
    remote: proposal.remote, remoteUrl: proposal.remoteUrl,
    targetMode: proposal.targetMode, targetBranch: proposal.targetBranch,
    initialRunId: proposal.initialRunId, latestRunId: proposal.latestRunId, latestDiffId: proposal.latestDiffId,
    decisionActor: proposal.decisionActor, decisionAt: proposal.decisionAt,
    pushedCommitSha: proposal.pushedCommitSha, pushedAt: proposal.pushedAt, rejectedAt: proposal.rejectedAt,
    lastError: proposal.lastError,
    reviewedChanges: diff
      ? { diffId: diff.id, revision: diff.revision, operations: diff.ops?.length ?? 0, stats: diff.stats, truncated: diff.truncated }
      : null,
    // Answers "why is approve refused" before the caller tries: a run that failed with nothing to
    // show leaves an empty revision, and then reject is the only way to release the directory.
    approvable: AgentWorkspaceProposalService.isApprovableDiff(diff ?? null),
    createdAt: proposal.createdAt, updatedAt: proposal.updatedAt,
  };
}

async function latestDiffsFor(proposals: AgentWorkspaceProposal[]): Promise<Map<string, AgentRunDiff>> {
  const ids = proposals.map((proposal) => proposal.latestDiffId).filter((id): id is string => !!id);
  if (!ids.length) return new Map();
  const diffs = await AgentRunDiff.findAll({ where: { id: { [Op.in]: ids } } });
  return new Map(diffs.map((diff) => [diff.id, diff]));
}

const proposalsTool: IMcpTool = {
  name: 'agentiz.proposals', group: 'agentiz',
  shortDescription: 'Lists workspace Git proposals and the worker directories they hold.',
  description: 'Lists workspace Git review proposals. A proposal with a non-null reservationKey owns its worker directory: until it reaches a decision every run on that path fails with "Workspace is reserved by proposal <id>", including runs of other tasks. Filter with holding=true to see only the proposals actually blocking a directory. The patch itself is never returned — call agentiz.runDetails on latestRunId for that.',
  mode: 'protected',
  inputSchema: {
    type: 'object',
    properties: {
      proposalId: { type: 'string' }, projectId: { type: 'string' }, taskId: { type: 'string' },
      workerId: { type: 'string' }, workspacePath: { type: 'string' }, status: { type: 'string' },
      holding: { type: 'boolean', description: 'true returns only proposals currently holding a workspace reservation.' },
      limit: { type: 'integer', default: LIMIT_DEFAULT, maximum: LIMIT_MAX },
    },
  },
  async handler(params) {
    const payload = objectParams(params);
    const proposalId = stringParam(payload, 'proposalId');
    const where = {
      ...(proposalId ? { id: proposalId } : {}),
      ...(stringParam(payload, 'projectId') ? { projectId: stringParam(payload, 'projectId') } : {}),
      ...(stringParam(payload, 'taskId') ? { taskId: stringParam(payload, 'taskId') } : {}),
      ...(stringParam(payload, 'workerId') ? { workerId: stringParam(payload, 'workerId') } : {}),
      ...(stringParam(payload, 'workspacePath') ? { workspacePath: stringParam(payload, 'workspacePath') } : {}),
      ...(stringParam(payload, 'status') ? { status: stringParam(payload, 'status') } : {}),
      ...(payload.holding === true ? { reservationKey: { [Op.ne]: null } } : {}),
    };
    const proposals = await AgentWorkspaceProposal.findAll({ where, order: [['updatedAt', 'DESC']], limit: limitParam(payload) });
    const diffs = await latestDiffsFor(proposals);
    return {
      count: proposals.length,
      items: proposals.map((proposal) => proposalTeaser(proposal, proposal.latestDiffId ? diffs.get(proposal.latestDiffId) : null)),
    };
  },
};

/**
 * The review decisions, which until now existed only as buttons on the run page. A workspace that a
 * failed run left reserved could not be released through the MCP surface at all — the directory
 * stayed blocked for every later run until somebody opened the dashboard.
 */
const manageProposalTool: IMcpTool = {
  name: 'agentiz.manageProposal', group: 'agentiz-actions',
  shortDescription: 'Approves, rejects or continues a workspace Git proposal.',
  description: 'Decides a workspace Git proposal. reject queues a workspace_reset job on the owning worker: the directory is stashed, then reset to the proposal base, the worker drops its on-disk marker and the reservation is released — this is how a workspace blocked by an abandoned proposal is freed, and the only available decision when a run failed with nothing to review (agentiz.proposals reports approvable=false). approve queues commit/push of the reviewed revision. continue starts another run on the same workspace from a comment. release does what reject does but from any live status, including the ones reject refuses with 409 (working, continuing, apply_queued, reset_queued) — use it when a run was cancelled or its worker died and the directory stayed reserved; release with force=true additionally drops the reservation without waiting for the worker, for a worker that is gone for good, and then leaves the directory untouched for a human to clean. Neither destroys work: the worker stashes the directory before restoring it (git stash apply <stashSha>, reported back on the proposal), so reject/release is a verdict on the proposal, not on the files. Only force=true skips that, because it skips the worker.',
  mode: 'protected',
  inputSchema: {
    type: 'object',
    required: ['action', 'proposalId'],
    properties: {
      action: { type: 'string', enum: ['approve', 'reject', 'continue', 'release'] },
      proposalId: { type: 'string' },
      revision: { type: 'integer', description: 'Optimistic guard: the revision you read. Omit only when acting on state just fetched — the proposal\'s current revision is then used.' },
      actor: { type: 'string', description: 'Recorded as the deciding actor. Defaults to "mcp".' },
      targetBranch: { type: 'string', description: 'approve only: overrides the branch the commit is pushed to.' },
      commitMessage: { type: 'string', description: 'approve only: overrides the commit message.' },
      comment: { type: 'string', description: 'continue only: the instruction for the next run. Required for continue.' },
      force: { type: 'boolean', description: 'release only: drop the reservation immediately instead of waiting for the worker to restore the directory. Only for a worker that will not come back — the files are left as they are and the next run there fails until somebody cleans it.' },
      reason: { type: 'string', description: 'release only: recorded on the proposal and in the run log.' },
    },
  },
  async handler(params) {
    const payload = objectParams(params);
    const action = requiredString(payload, 'action');
    const proposalId = requiredString(payload, 'proposalId');
    const actor = stringParam(payload, 'actor') ?? 'mcp';
    const current = await AgentWorkspaceProposal.findByPk(proposalId);
    if (!current) throw new Error(`AgentWorkspaceProposal ${proposalId} not found`);
    const revision = typeof payload.revision === 'number' ? Math.floor(payload.revision) : current.revision;

    if (action === 'continue') {
      const comment = requiredString(payload, 'comment');
      const run = await AgentWorkspaceProposalService.continueWork(proposalId, revision, { id: null, name: actor }, comment);
      return { action, proposalId, revision, runId: run.id, runStatus: run.status };
    }
    if (action === 'release') {
      const outcome = await AgentWorkspaceProposalService.release(proposalId, actor, {
        force: payload.force === true,
        reason: stringParam(payload, 'reason'),
      });
      const diff = outcome.proposal.latestDiffId ? await AgentRunDiff.findByPk(outcome.proposal.latestDiffId) : null;
      return {
        action, proposalId,
        proposal: proposalTeaser(outcome.proposal, diff),
        queuedJob: outcome.queuedJobId,
        note: outcome.released
          ? `Reservation dropped without a worker; ${outcome.proposal.workspacePath} was not restored and may still hold uncommitted work.`
          : `Queued workspace_reset on worker ${outcome.proposal.workerId}; the workspace stays reserved until that job reports success.`,
      };
    }
    if (action !== 'approve' && action !== 'reject') throw new Error(`Unsupported action: ${action}`);

    const proposal = action === 'approve'
      ? await AgentWorkspaceProposalService.approve(proposalId, revision, actor, {
          targetBranch: stringParam(payload, 'targetBranch'), commitMessage: stringParam(payload, 'commitMessage'),
        })
      : await AgentWorkspaceProposalService.reject(proposalId, revision, actor);
    const jobKind = action === 'approve' ? 'workspace_commit_push' : 'workspace_reset';
    // The decision only queues work; the reservation is released when the worker reports the job
    // done, so hand back the job to watch instead of implying the directory is already free.
    const job = await AgentRunJob.findOne({ where: { proposalId, jobKind }, order: [['createdAt', 'DESC']] });
    const diff = proposal.latestDiffId ? await AgentRunDiff.findByPk(proposal.latestDiffId) : null;
    return {
      action, proposalId, revision,
      proposal: proposalTeaser(proposal, diff),
      queuedJob: job ? { id: job.id, jobKind: job.jobKind, status: job.status, requiredWorkerId: job.requiredWorkerId } : null,
      note: `Queued ${jobKind} on worker ${proposal.workerId}; the workspace stays reserved until that job reports success.`,
    };
  },
};

export const agentizProposalMcpTools: IMcpTool[] = [proposalsTool, manageProposalTool];
