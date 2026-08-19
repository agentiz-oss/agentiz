import { Op } from 'sequelize';
import { AgentWorkspaceProposal } from '../models/AgentWorkspaceProposal';
import { AgentRunDiff } from '../models/AgentRunDiff';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentRun } from '../models/AgentRun';
import { AgentTask } from '../models/AgentTask';
import { AgentTaskComment } from '../models/AgentTaskComment';
import { AgentRepository } from '../models/AgentRepository';
import { AgentPipelineService } from './AgentPipelineService';
import { ActivityService } from './ActivityService';
import { assertWorkspaceBranch } from '../lib/workspaceBranch';

export class WorkspaceProposalError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); }
}

function assertRevision(proposal: AgentWorkspaceProposal, revision: number): void {
  if (proposal.revision !== revision) {
    throw new WorkspaceProposalError(409, `Proposal revision ${revision} is stale; latest is ${proposal.revision}`);
  }
}

export class AgentWorkspaceProposalService {
  static async detailsForRun(run: AgentRun): Promise<{ proposal: AgentWorkspaceProposal; revisions: AgentRunDiff[] } | null> {
    if (!run.proposalId) return null;
    const proposal = await AgentWorkspaceProposal.findByPk(run.proposalId);
    if (!proposal) return null;
    const revisions = await AgentRunDiff.findAll({ where: { proposalId: proposal.id }, order: [['revision', 'ASC']] });
    return { proposal, revisions };
  }

  /**
   * Whether a reviewed revision is complete enough to be committed and pushed.
   *
   * A run that failed before touching anything still leaves a revision behind — empty patch, zero
   * operations — and approving that would invent an approval nobody gave. Exposed because callers
   * outside the review UI (the MCP proposal tools) have to be able to say *why* approve is closed
   * without restating the rule and letting the two drift apart.
   */
  static isApprovableDiff(diff: AgentRunDiff | null): boolean {
    return !!diff && !!diff.treeSha && !!diff.patchSha256 && !diff.truncated && (diff.ops?.length ?? 0) > 0;
  }

  static async approve(
    proposalId: string,
    revision: number,
    actor: string,
    edits: { targetBranch?: string; commitMessage?: string } = {},
  ): Promise<AgentWorkspaceProposal> {
    const proposal = await this.require(proposalId);
    assertRevision(proposal, revision);
    if (!['waiting_review', 'push_failed'].includes(proposal.status)) {
      throw new WorkspaceProposalError(409, `Proposal cannot be approved while it is ${proposal.status}`);
    }
    const diff = await AgentRunDiff.findOne({ where: { proposalId, revision } });
    if (!this.isApprovableDiff(diff)) {
      throw new WorkspaceProposalError(409, 'The complete reviewed diff is unavailable; commit/push is blocked');
    }
    const branch = edits.targetBranch?.trim() || proposal.targetBranch;
    if (proposal.targetMode === 'new') {
      if (!branch) throw new WorkspaceProposalError(400, 'Target branch is required');
      assertWorkspaceBranch(branch);
    }
    const commitMessage = edits.commitMessage?.trim() || proposal.commitMessage.trim();
    if (!commitMessage) throw new WorkspaceProposalError(400, 'Commit message is required');

    const [changed] = await AgentWorkspaceProposal.update({
      status: 'apply_queued',
      targetBranch: branch,
      commitMessage,
      decisionActor: actor,
      decisionAt: new Date(),
      lastError: null,
    }, { where: { id: proposal.id, revision, status: { [Op.in]: ['waiting_review', 'push_failed'] } } });
    if (changed !== 1) throw new WorkspaceProposalError(409, 'Proposal changed while it was being approved');
    await proposal.reload();
    try {
      await this.enqueueAction(proposal, 'workspace_commit_push');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await proposal.update({ status: 'push_failed', lastError: message });
      await this.recordFailureActivity(proposal, 'push_failed', message);
      throw error;
    }
    return proposal;
  }

  static async reject(proposalId: string, revision: number, actor: string): Promise<AgentWorkspaceProposal> {
    const proposal = await this.require(proposalId);
    assertRevision(proposal, revision);
    if (!['waiting_review', 'push_failed', 'reset_failed'].includes(proposal.status)) {
      throw new WorkspaceProposalError(409, `Proposal cannot be rejected while it is ${proposal.status}`);
    }
    const [changed] = await AgentWorkspaceProposal.update({
      status: 'reset_queued', decisionActor: actor, decisionAt: new Date(), lastError: null,
    }, { where: { id: proposal.id, revision, status: { [Op.in]: ['waiting_review', 'push_failed', 'reset_failed'] } } });
    if (changed !== 1) throw new WorkspaceProposalError(409, 'Proposal changed while it was being rejected');
    await proposal.reload();
    try {
      await this.enqueueAction(proposal, 'workspace_reset');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await proposal.update({ status: 'reset_failed', lastError: message });
      await this.recordFailureActivity(proposal, 'reset_failed', message);
      throw error;
    }
    return proposal;
  }

  /**
   * A pipeline can fail after the worker has written its on-disk proposal marker but before it has
   * produced anything reviewable.  That marker must be removed by the worker; releasing the
   * database reservation alone would make later runs fail on the stale marker forever.
   *
   * This deliberately keeps the reservation while the reset is queued.  If queuing fails, the
   * proposal remains recoverable as `reset_failed`, which an operator can retry through reject.
   */
  static async resetAfterUnreviewableFailure(
    proposal: AgentWorkspaceProposal,
    reason: string,
  ): Promise<AgentWorkspaceProposal> {
    const [changed] = await AgentWorkspaceProposal.update({
      status: 'reset_queued',
      lastError: reason,
    }, {
      where: { id: proposal.id, revision: proposal.revision, status: { [Op.in]: ['working', 'continuing'] } },
    });
    if (changed !== 1) {
      throw new WorkspaceProposalError(409, 'Proposal changed while failed workspace cleanup was being queued');
    }
    await proposal.reload();
    try {
      await this.enqueueAction(proposal, 'workspace_reset');
    } catch (error) {
      const cleanupError = error instanceof Error ? error.message : String(error);
      await proposal.update({ status: 'reset_failed', lastError: `${reason}; workspace reset could not be queued: ${cleanupError}` });
    }
    return proposal;
  }

  static async continueWork(
    proposalId: string,
    revision: number,
    actor: { id: number | null; name: string },
    body: string,
  ): Promise<AgentRun> {
    const proposal = await this.require(proposalId);
    assertRevision(proposal, revision);
    if (proposal.status !== 'waiting_review') {
      throw new WorkspaceProposalError(409, `Proposal cannot continue while it is ${proposal.status}`);
    }
    const text = body.trim();
    if (!text) throw new WorkspaceProposalError(400, 'Comment is required');
    const latestRun = await AgentRun.findByPk(proposal.latestRunId);
    if (!latestRun) throw new WorkspaceProposalError(404, 'Latest proposal run is missing');
    const comment = await AgentTaskComment.create({
      taskId: proposal.taskId,
      authorKind: 'human', authorName: actor.name, authorId: actor.id, runId: null,
      body: text, origin: 'local', externalId: null, externalUrl: null, externalCreatedAt: null,
      meta: { kind: 'workspace_review.continue', proposalId, revision },
    });
    const nextRevision = proposal.revision + 1;
    const [changed] = await AgentWorkspaceProposal.update({ status: 'continuing' }, {
      where: { id: proposal.id, revision, status: 'waiting_review' },
    });
    if (changed !== 1) throw new WorkspaceProposalError(409, 'Proposal changed while continuation was being queued');
    let continuationRun: AgentRun | null = null;
    try {
      const run = await AgentPipelineService.createRun(proposal.taskId, 'human_comment', {
        triggerCommentId: comment.id,
        pipelineSnapshot: latestRun.pipelineSnapshot,
        proposalId: proposal.id,
        workspaceRevision: nextRevision,
      });
      continuationRun = run;
      await proposal.update({ latestRunId: run.id, revision: nextRevision, status: 'working', lastError: null });
      await AgentPipelineService.log(run.id, run.projectId, null, 'info', `Continuing workspace proposal ${proposal.id}, revision ${nextRevision}`);
      // Queue explicitly: review continuation does not depend on triggers.humanComment.
      const { AgentWorkerJobBuilder } = await import('./AgentPipelineService');
      await AgentWorkerJobBuilder.enqueueRun(run);
      return run;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await proposal.update({ latestRunId: latestRun.id, revision, status: 'waiting_review', lastError: message });
      if (continuationRun) await continuationRun.update({ status: 'failed', finishedAt: new Date(), errorMessage: message });
      await AgentTask.update({ status: 'waiting_review' }, { where: { id: proposal.taskId } });
      throw error;
    }
  }

  private static async enqueueAction(
    proposal: AgentWorkspaceProposal,
    jobKind: 'workspace_commit_push' | 'workspace_reset',
  ): Promise<AgentRunJob> {
    const [run, repository] = await Promise.all([
      AgentRun.findByPk(proposal.latestRunId),
      // Absent by design when the directory pushes through its own remote; only a *pinned* repository
      // that has since been deleted is an error worth stopping for.
      proposal.repositoryId ? AgentRepository.findByPk(proposal.repositoryId) : Promise.resolve(null),
    ]);
    if (!run) throw new WorkspaceProposalError(404, 'Proposal run is missing');
    if (proposal.repositoryId && !repository) {
      throw new WorkspaceProposalError(404, `Proposal repository ${proposal.repositoryId} no longer exists`);
    }
    const existing = await AgentRunJob.findOne({
      where: { proposalId: proposal.id, jobKind, status: { [Op.in]: ['queued', 'leased', 'running', 'succeeded'] } },
      order: [['createdAt', 'DESC']],
    });
    if (existing) return existing;
    return AgentRunJob.create({
      runId: run.id,
      projectId: proposal.projectId,
      jobKind,
      proposalId: proposal.id,
      status: 'queued', priority: 50, attempt: 0, workerId: null,
      repositoryId: proposal.repositoryId,
      requiredWorkerId: proposal.workerId,
      leaseTokenHash: null, lockedUntil: null, availableAt: new Date(),
      cancelRequestedAt: null, cancelReason: null,
      snapshot: {
        schemaVersion: 1,
        jobKind,
        runId: run.id,
        workspace: { workerId: proposal.workerId, key: proposal.workspaceKey, path: proposal.workspacePath, createIfMissing: false },
        // Null means "trust the directory's own remote": the worker then records where it actually
        // pushed instead of verifying it against a URL Agentiz holds.
        repository: repository
          ? {
              repositoryId: repository.id,
              cloneUrl: repository.cloneUrl,
              pathWithNamespace: repository.pathWithNamespace,
            }
          : null,
        proposal: {
          id: proposal.id, revision: proposal.revision,
          baseSha: proposal.baseSha, baseBranch: proposal.baseBranch,
          remote: proposal.remote, remoteUrl: proposal.remoteUrl, remoteBaseSha: proposal.remoteBaseSha,
          expectedTreeSha: proposal.expectedTreeSha,
          targetMode: proposal.targetMode, targetBranch: proposal.targetBranch,
          commitMessage: proposal.commitMessage,
        },
      },
      result: null, lastError: null,
    });
  }

  private static async require(id: string): Promise<AgentWorkspaceProposal> {
    const proposal = await AgentWorkspaceProposal.findByPk(id);
    if (!proposal) throw new WorkspaceProposalError(404, 'Workspace proposal not found');
    return proposal;
  }

  /**
   * The queue-time twin of the worker-result emit in AgentWorkerApiService: an approve/reject
   * whose action job could not even be queued leaves the proposal in the same push_failed /
   * reset_failed state, and the owner has to hear about it the same way.
   * `resetAfterUnreviewableFailure` deliberately stays silent — that is cleanup, and run.failed
   * has already said the important part.
   */
  private static async recordFailureActivity(
    proposal: AgentWorkspaceProposal,
    failure: 'push_failed' | 'reset_failed',
    message: string,
  ): Promise<void> {
    await ActivityService.record({
      type: `proposal.${failure}`,
      projectId: proposal.projectId,
      runId: proposal.latestRunId,
      taskId: proposal.taskId,
      proposalId: proposal.id,
      title: failure === 'push_failed' ? 'Push изменений не удался' : 'Сброс воркспейса не удался',
      body: message,
      data: { revision: proposal.revision, errorMessage: message.slice(0, 1000) },
    });
  }
}
