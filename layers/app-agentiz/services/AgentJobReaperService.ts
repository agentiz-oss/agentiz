import { Op } from 'sequelize';
import { AgentRun } from '../models/AgentRun';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentTask } from '../models/AgentTask';
import { AgentPipelineService } from './AgentPipelineService';
import { AgentRunInteractionService } from './AgentRunInteractionService';
import { ActivityService } from './ActivityService';
import { AgentWorkspaceProposal } from '../models/AgentWorkspaceProposal';
import { AgentWorkspaceProposalService } from './AgentWorkspaceProposalService';

/** How often the sweep runs. */
const SWEEP_INTERVAL_MS = Number(process.env.AGENTIZ_JOB_REAPER_INTERVAL_MS ?? 15_000);
/** After this many attempts a job stops being retried and is buried as `dead`. */
const MAX_ATTEMPTS = Number(process.env.AGENTIZ_JOB_MAX_ATTEMPTS ?? 5);
/** Backoff applied when a lease is reclaimed, so a job that kills workers does not spin. */
const RETRY_BACKOFF_MS = Number(process.env.AGENTIZ_JOB_RETRY_BACKOFF_MS ?? 30_000);
/** How long an approve/reject may sit in a queue no worker is emptying before the decision reopens. */
const ACTION_TIMEOUT_MS = Number(process.env.AGENTIZ_PROPOSAL_ACTION_TIMEOUT_MS ?? 15 * 60_000);
/** Grace after a run ends before its proposal counts as stranded, so this never races the result. */
const STRANDED_GRACE_MS = Number(process.env.AGENTIZ_PROPOSAL_STRANDED_GRACE_MS ?? 2 * 60_000);

/**
 * Returns abandoned jobs to the queue.
 *
 * Two states cannot recover on their own, because `claim` only ever looks at `status: 'queued'`:
 *
 * - `released` — a worker said "I cannot run this, give it to someone else" and got a `retryAt`
 *   back. Without this sweep that promise is never kept and the job is orphaned for good.
 * - `leased` / `running` with an expired `lockedUntil` — the worker died mid-job. The lease is
 *   worthless (heartbeat and result are rejected with 409 "Lease expired") but nothing frees it,
 *   so the run stays `running` forever.
 *
 * The sweep is deliberately independent of AgentWorkerQueueService: that one is disabled whenever
 * the remote Worker API is on, which is exactly the deployment where abandoned leases happen.
 */
export class AgentJobReaperService {
  private static timer: NodeJS.Timeout | null = null;
  private static running = false;

  static start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweepOnce().catch((error) => {
        console.error('[AgentizJobReaper] sweep failed:', error);
      });
    }, Math.max(SWEEP_INTERVAL_MS, 1000));
    // Unref so the interval never holds the process open on shutdown.
    this.timer.unref?.();
    console.log(`[AgentizJobReaper] started (every ${Math.max(SWEEP_INTERVAL_MS, 1000)}ms, maxAttempts=${MAX_ATTEMPTS})`);
  }

  static stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  static async sweepOnce(): Promise<{
    requeuedReleased: number; reclaimedLeases: number; buried: number; recoveredProposals: number;
  }> {
    if (this.running) return { requeuedReleased: 0, reclaimedLeases: 0, buried: 0, recoveredProposals: 0 };
    this.running = true;
    try {
      const requeuedReleased = await this.requeueReleased();
      const { reclaimed, buried } = await this.reclaimExpiredLeases();
      const recoveredProposals = await this.recoverStrandedProposals();
      return { requeuedReleased, reclaimedLeases: reclaimed, buried, recoveredProposals };
    } finally {
      this.running = false;
    }
  }

  /** `released` + backoff elapsed -> back into the queue. */
  private static async requeueReleased(): Promise<number> {
    const jobs = await AgentRunJob.findAll({
      where: { status: 'released', availableAt: { [Op.lte]: new Date() } },
      limit: 50,
    });
    for (const job of jobs) {
      if (await this.buryIfExhausted(job, 'released too many times')) continue;
      await job.update({ status: 'queued', workerId: null, leaseTokenHash: null, lockedUntil: null });
      await AgentPipelineService.log(job.runId, job.projectId, null, 'info', 'Released job returned to the queue', {
        jobId: job.id,
        attempt: job.attempt,
      });
    }
    return jobs.length;
  }

  /** A lease nobody renewed is a dead worker: take the job back. */
  private static async reclaimExpiredLeases(): Promise<{ reclaimed: number; buried: number }> {
    const jobs = await AgentRunJob.findAll({
      where: {
        status: { [Op.in]: ['leased', 'running'] },
        lockedUntil: { [Op.ne]: null, [Op.lt]: new Date() },
      },
      limit: 50,
    });
    let reclaimed = 0;
    let buried = 0;
    for (const job of jobs) {
      if (await this.buryIfExhausted(job, 'lease expired too many times')) {
        buried += 1;
        continue;
      }
      await AgentRunInteractionService.closeForJob(job, 'orphaned', 'worker lease expired');
      await job.update({
        status: 'queued',
        workerId: null,
        leaseTokenHash: null,
        lockedUntil: null,
        availableAt: new Date(Date.now() + RETRY_BACKOFF_MS),
        lastError: `Lease expired after attempt ${job.attempt}, job requeued`,
      });
      await AgentPipelineService.log(job.runId, job.projectId, null, 'warn', 'Worker lease expired, job returned to the queue', {
        jobId: job.id,
        attempt: job.attempt,
      });
      reclaimed += 1;
    }
    return { reclaimed, buried };
  }

  /**
   * Brings a workspace reservation nobody is working on back to a state that has a button.
   *
   * A proposal holds its directory against every later run, and only a worker result moves it out
   * of the four machine-owned statuses. Two gaps leave one hanging there forever, and the lease
   * machinery above closes neither, because both are jobs that no worker ever took:
   *
   * - `working`/`continuing` after the run is over — a cancelled run, or a pipeline job buried by
   *   `buryIfExhausted` (which skips proposals for `pipeline` jobs, since only the worker knows
   *   whether the on-disk marker exists). Handled by queuing the same reset an unreviewable failure
   *   queues; the directory is restored and the reservation falls away with that job's result.
   * - `apply_queued`/`reset_queued` whose action job was never claimed — the owning worker is
   *   offline, paused or revoked, so `attempt` never increments and the bury path is unreachable.
   *   The decision is reopened as `push_failed`/`reset_failed`, which the review UI and MCP can act
   *   on again; the stale job is cancelled so it cannot wake up later and report against a proposal
   *   that has moved on.
   *
   * Queuing a reset without asking anyone is safe because the reset stashes: the worker puts the
   * directory into `git stash` before restoring it, and the sha comes back on the proposal. What
   * neither arm does is clear `reservationKey` on its own — the worker's on-disk marker outlives
   * the row, so a release nobody carried out would trade this block for a less legible one. That
   * decision stays with a person: `AgentWorkspaceProposalService.release`.
   */
  private static async recoverStrandedProposals(): Promise<number> {
    const now = Date.now();
    const proposals = await AgentWorkspaceProposal.findAll({
      where: {
        reservationKey: { [Op.ne]: null },
        status: { [Op.in]: ['working', 'continuing', 'apply_queued', 'applying', 'reset_queued', 'resetting'] },
        updatedAt: { [Op.lt]: new Date(now - Math.min(STRANDED_GRACE_MS, ACTION_TIMEOUT_MS)) },
      },
      limit: 50,
    });
    let recovered = 0;
    for (const proposal of proposals) {
      const handled = ['working', 'continuing'].includes(proposal.status)
        ? await this.recoverAbandonedRun(proposal, now)
        : await this.reopenUnclaimedDecision(proposal, now);
      if (handled) recovered += 1;
    }
    return recovered;
  }

  /** `working`/`continuing` whose run has ended without anything reporting the proposal. */
  private static async recoverAbandonedRun(proposal: AgentWorkspaceProposal, now: number): Promise<boolean> {
    if (proposal.updatedAt.getTime() > now - STRANDED_GRACE_MS) return false;
    const live = await AgentRunJob.count({
      where: { runId: proposal.latestRunId, status: { [Op.in]: ['queued', 'released', 'leased', 'running'] } },
    });
    if (live > 0) return false;
    const run = await AgentRun.findByPk(proposal.latestRunId);
    if (run && !['succeeded', 'failed', 'cancelled'].includes(run.status)) return false;
    const reason = `Run ${proposal.latestRunId} ended as ${run?.status ?? 'missing'} without deciding the workspace proposal`;
    await AgentPipelineService.log(proposal.latestRunId, proposal.projectId, null, 'warn',
      `Stranded workspace proposal recovered: ${reason}`, { proposalId: proposal.id, workspacePath: proposal.workspacePath });
    try {
      await AgentWorkspaceProposalService.resetAfterUnreviewableFailure(proposal, reason);
    } catch (error) {
      // A concurrent decision won the race; the next sweep sees the new status.
      console.warn('[AgentizJobReaper] proposal recovery skipped:', error instanceof Error ? error.message : error);
      return false;
    }
    return true;
  }

  /** `*_queued` whose action job no worker ever claimed. */
  private static async reopenUnclaimedDecision(proposal: AgentWorkspaceProposal, now: number): Promise<boolean> {
    if (proposal.updatedAt.getTime() > now - ACTION_TIMEOUT_MS) return false;
    const jobKind = ['apply_queued', 'applying'].includes(proposal.status) ? 'workspace_commit_push' : 'workspace_reset';
    const job = await AgentRunJob.findOne({
      where: { proposalId: proposal.id, jobKind },
      order: [['createdAt', 'DESC']],
    });
    // Anything ever claimed travels the lease path above: it is retried, and buried into the same
    // failed status once its attempts are spent. Only a job still sitting at attempt 0 is stuck.
    if (job && !(['queued', 'released'].includes(job.status) && job.attempt === 0)) return false;
    if (job && job.createdAt.getTime() > now - ACTION_TIMEOUT_MS) return false;
    const minutes = Math.round(ACTION_TIMEOUT_MS / 60_000);
    const reason = job
      ? `No worker claimed ${jobKind} within ${minutes} min (worker ${proposal.workerId} offline, paused or revoked)`
      : `${jobKind} job disappeared before any worker ran it`;
    const failedStatus = jobKind === 'workspace_commit_push' ? 'push_failed' : 'reset_failed';
    const [changed] = await AgentWorkspaceProposal.update(
      { status: failedStatus, lastError: reason },
      { where: { id: proposal.id, status: proposal.status } },
    );
    if (changed !== 1) return false;
    if (job) await job.update({ status: 'cancelled', cancelRequestedAt: new Date(), cancelReason: reason, lockedUntil: null });
    await AgentTask.update({ status: 'waiting_review' }, { where: { id: proposal.taskId } });
    await AgentPipelineService.log(proposal.latestRunId, proposal.projectId, null, 'error',
      `Workspace decision reopened: ${reason}`, { proposalId: proposal.id, jobKind });
    await ActivityService.record({
      type: `proposal.${failedStatus}`,
      projectId: proposal.projectId,
      runId: proposal.latestRunId,
      taskId: proposal.taskId,
      proposalId: proposal.id,
      title: failedStatus === 'push_failed' ? 'Push изменений не удался' : 'Сброс воркспейса не удался',
      body: reason,
      data: { revision: proposal.revision, errorMessage: reason, workspacePath: proposal.workspacePath },
    });
    return true;
  }

  /**
   * Retrying forever would hide a job that no worker can ever finish. Once the budget is spent the
   * job is buried and the run/task are failed, so the task surfaces in the UI instead of hanging
   * in `running` indefinitely.
   */
  private static async buryIfExhausted(job: AgentRunJob, reason: string): Promise<boolean> {
    if (job.attempt < MAX_ATTEMPTS) return false;
    await AgentRunInteractionService.closeForJob(job, 'orphaned', reason);
    await job.update({
      status: 'dead',
      workerId: null,
      leaseTokenHash: null,
      lockedUntil: null,
      lastError: `${reason} (attempt ${job.attempt}/${MAX_ATTEMPTS})`,
    });
    if (job.proposalId && job.jobKind !== 'pipeline') {
      const proposal = await AgentWorkspaceProposal.findByPk(job.proposalId);
      if (proposal) {
        await proposal.update({
          status: job.jobKind === 'workspace_commit_push' ? 'push_failed' : 'reset_failed',
          lastError: `${reason} (attempt ${job.attempt}/${MAX_ATTEMPTS})`,
        });
        await AgentTask.update({ status: 'waiting_review' }, { where: { id: proposal.taskId } });
      }
    }
    const run = await AgentRun.findByPk(job.runId);
    if (run && !['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      await run.update({
        status: 'failed',
        finishedAt: new Date(),
        errorMessage: `Job abandoned: ${reason} (attempt ${job.attempt}/${MAX_ATTEMPTS})`,
      });
      await AgentRunInteractionService.setTaskStatusConsideringActiveRuns(run.taskId, 'failed');
    }
    await AgentPipelineService.log(job.runId, job.projectId, null, 'error', `Job buried: ${reason}`, {
      jobId: job.id,
      attempt: job.attempt,
    });
    return true;
  }
}
