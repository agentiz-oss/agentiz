import { Op } from 'sequelize';
import { AgentWorkspaceProposal } from '../models/AgentWorkspaceProposal';
import { AgentRunDiff } from '../models/AgentRunDiff';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentRun } from '../models/AgentRun';
import { AgentTask } from '../models/AgentTask';
import { AgentTaskComment } from '../models/AgentTaskComment';
import { AgentRepository } from '../models/AgentRepository';
import { AgentPipelineService } from './AgentPipelineService';
import { AgentRunInteractionService } from './AgentRunInteractionService';
import { ActivityService } from './ActivityService';
import { assertWorkspaceBranch } from '../lib/workspaceBranch';
import { workspaceStashLabel } from '../lib/workspaceGit';
import type { AgentWorkspaceProposalStatus } from '../types/agentiz';

/**
 * The statuses in which a proposal still owns its directory. Everything else has already cleared
 * `reservationKey`, so there is nothing left to release.
 */
export const LIVE_PROPOSAL_STATUSES: readonly AgentWorkspaceProposalStatus[] = [
  'working', 'continuing', 'waiting_review',
  'apply_queued', 'applying', 'reset_queued', 'resetting',
  'push_failed', 'reset_failed',
];

/** A worker is mid-action on the directory; a second job queued now would only fight it for the lock. */
export const IN_FLIGHT_PROPOSAL_STATUSES: readonly AgentWorkspaceProposalStatus[] = [
  'apply_queued', 'applying', 'reset_queued', 'resetting',
];

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
   * Frees the directory from *any* live status — the manual counterpart of the reaper's recovery
   * sweep, and the only exit some of those statuses have.
   *
   * `reject()` is a review decision and refuses everything but the three states a reviewer is
   * looking at, because approving or rejecting mid-action would race the worker's own report. Every
   * other live status keeps the directory reserved all the same, and until this existed only a
   * worker result could leave them: a cancelled run, a buried pipeline job or a worker that never
   * came back blocked the path for good, answering `Workspace ... is reserved by proposal <id>` to
   * every later run while `reject` answered 409. This is what a person presses then.
   *
   * Safe mode stops whatever is in flight and queues the same `workspace_reset` a rejection would,
   * so the directory is restored, the worker drops its marker and the reservation falls away with
   * that job's result. `force` is for the case that cannot ever work — the owning worker is gone:
   * the reservation is dropped here and now and nothing is promised about the files, which stay
   * exactly as that machine left them.
   */
  static async release(
    proposalId: string,
    actor: string,
    options: { force?: boolean; reason?: string } = {},
  ): Promise<{ proposal: AgentWorkspaceProposal; released: boolean; queuedJobId: string | null }> {
    const proposal = await this.require(proposalId);
    const reason = options.reason?.trim() || `Workspace released by ${actor}`;
    // Idempotent on purpose: two people pressing the button, or a button pressed after the reaper
    // already recovered the proposal, must not turn into an error the second time.
    if (!proposal.reservationKey) return { proposal, released: true, queuedJobId: null };

    const holder = await this.liveLeaseHolder(proposal);
    if (holder && !options.force) {
      // Ask before refusing, so the retry this suggests has something to succeed against: a live
      // lease also owns the worker-side flock, and a reset queued now would only fail on it.
      await holder.update({ cancelRequestedAt: new Date(), cancelReason: reason });
      throw new WorkspaceProposalError(
        409,
        `Worker is still running job ${holder.id} in this directory; cancellation has been requested`
        + ' — retry the release once it stops, or force it if the worker is gone for good',
      );
    }
    await this.stopInFlightWork(proposal, reason);

    if (options.force) {
      await proposal.update({
        status: 'rejected',
        reservationKey: null,
        rejectedAt: new Date(),
        decisionActor: actor,
        decisionAt: new Date(),
        // Written into `lastError` rather than swallowed: the directory was *not* restored, and no
        // worker was there to stash it. Naming the stash that *would* have been taken is what keeps
        // this recoverable — the next run on this directory takes exactly that stash and reports
        // its sha back here, and until then `git stash list` on the machine finds it by that name.
        lastError: `${reason} (forced: the directory was not restored. Whatever is left there will be`
          + ` stashed as "${workspaceStashLabel(proposal.id, proposal.revision)}" by the next run,`
          + ' or can be recovered by hand on the worker)',
      });
      await AgentPipelineService.log(proposal.latestRunId, proposal.projectId, null, 'warn',
        `Workspace reservation force-released by ${actor}`,
        { proposalId: proposal.id, workspacePath: proposal.workspacePath });
      await AgentTask.update({ status: 'cancelled' }, { where: { id: proposal.taskId } });
      return { proposal, released: true, queuedJobId: null };
    }

    // Guarded on holding the directory rather than on the status list: this is the exit of last
    // resort, and a row whose status somehow fell outside that list while `reservationKey` is still
    // set is exactly the row that must not be told to try again later.
    const [changed] = await AgentWorkspaceProposal.update({
      status: 'reset_queued', decisionActor: actor, decisionAt: new Date(), lastError: reason,
    }, { where: { id: proposal.id, reservationKey: { [Op.ne]: null } } });
    if (changed !== 1) throw new WorkspaceProposalError(409, 'Proposal changed while it was being released');
    await proposal.reload();
    let job: AgentRunJob;
    try {
      job = await this.enqueueAction(proposal, 'workspace_reset');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await proposal.update({ status: 'reset_failed', lastError: `${reason}; workspace reset could not be queued: ${message}` });
      await this.recordFailureActivity(proposal, 'reset_failed', message);
      throw error;
    }
    return { proposal, released: false, queuedJobId: job.id };
  }

  /**
   * The job actually holding the directory right now, if any.
   *
   * Only a live lease counts: an expired one belongs to a worker that died, and
   * AgentJobReaperService is what returns those to the queue. A job whose lease is alive owns the
   * worker-side `flock` too, so queuing a reset against it produces nothing but a second failure.
   */
  private static async liveLeaseHolder(proposal: AgentWorkspaceProposal): Promise<AgentRunJob | null> {
    return AgentRunJob.findOne({
      where: {
        [Op.or]: [{ proposalId: proposal.id }, { runId: proposal.latestRunId }],
        status: { [Op.in]: ['leased', 'running'] },
        lockedUntil: { [Op.gt]: new Date() },
      },
    });
  }

  /**
   * Takes the proposal's unfinished work out of the queue before the directory changes hands.
   *
   * Whatever is still queued would otherwise report against a proposal that has moved on and be
   * refused with a 409, and — worse for a `force` — a job claimed afterwards would touch a
   * directory nobody is tracking any more. A live lease can only be *asked* to stop; the reaper
   * collects it when it expires.
   */
  private static async stopInFlightWork(proposal: AgentWorkspaceProposal, reason: string): Promise<void> {
    const jobs = await AgentRunJob.findAll({
      where: {
        [Op.or]: [{ proposalId: proposal.id }, { runId: proposal.latestRunId }],
        status: { [Op.in]: ['queued', 'released', 'leased', 'running'] },
      },
    });
    for (const job of jobs) {
      await AgentRunInteractionService.closeForJob(job, 'cancelled', reason);
      if (job.status === 'queued' || job.status === 'released') {
        await job.update({ status: 'cancelled', cancelRequestedAt: new Date(), cancelReason: reason, lockedUntil: null });
      } else {
        await job.update({ cancelRequestedAt: new Date(), cancelReason: reason });
      }
    }
    const run = await AgentRun.findByPk(proposal.latestRunId);
    if (run && !['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      // An instance update: `run.cancelled` is emitted from the model's @AfterUpdate hook.
      await run.update({ status: 'cancelled', finishedAt: new Date(), errorMessage: reason });
    }
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
    const [latestRun, repository] = await Promise.all([
      AgentRun.findByPk(proposal.latestRunId),
      // Absent by design when the directory pushes through its own remote; only a *pinned* repository
      // that has since been deleted is an error worth stopping for.
      proposal.repositoryId ? AgentRepository.findByPk(proposal.repositoryId) : Promise.resolve(null),
    ]);
    // A job needs some run to hang off. Falling back to the first one keeps a reset possible when
    // the latest run row is gone — without it a missing row would make the directory unreleasable.
    const run = latestRun ?? await AgentRun.findByPk(proposal.initialRunId);
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
