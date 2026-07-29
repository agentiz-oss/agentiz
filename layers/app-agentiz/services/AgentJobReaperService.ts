import { Op } from 'sequelize';
import { AgentRun } from '../models/AgentRun';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentTask } from '../models/AgentTask';
import { AgentPipelineService } from './AgentPipelineService';

/** How often the sweep runs. */
const SWEEP_INTERVAL_MS = Number(process.env.AGENTIZ_JOB_REAPER_INTERVAL_MS ?? 15_000);
/** After this many attempts a job stops being retried and is buried as `dead`. */
const MAX_ATTEMPTS = Number(process.env.AGENTIZ_JOB_MAX_ATTEMPTS ?? 5);
/** Backoff applied when a lease is reclaimed, so a job that kills workers does not spin. */
const RETRY_BACKOFF_MS = Number(process.env.AGENTIZ_JOB_RETRY_BACKOFF_MS ?? 30_000);

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

  static async sweepOnce(): Promise<{ requeuedReleased: number; reclaimedLeases: number; buried: number }> {
    if (this.running) return { requeuedReleased: 0, reclaimedLeases: 0, buried: 0 };
    this.running = true;
    try {
      const requeuedReleased = await this.requeueReleased();
      const { reclaimed, buried } = await this.reclaimExpiredLeases();
      return { requeuedReleased, reclaimedLeases: reclaimed, buried };
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
      await AgentPipelineService.log(job.runId, null, 'info', 'Released job returned to the queue', {
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
      await job.update({
        status: 'queued',
        workerId: null,
        leaseTokenHash: null,
        lockedUntil: null,
        availableAt: new Date(Date.now() + RETRY_BACKOFF_MS),
        lastError: `Lease expired after attempt ${job.attempt}, job requeued`,
      });
      await AgentPipelineService.log(job.runId, null, 'warn', 'Worker lease expired, job returned to the queue', {
        jobId: job.id,
        attempt: job.attempt,
      });
      reclaimed += 1;
    }
    return { reclaimed, buried };
  }

  /**
   * Retrying forever would hide a job that no worker can ever finish. Once the budget is spent the
   * job is buried and the run/task are failed, so the task surfaces in the UI instead of hanging
   * in `running` indefinitely.
   */
  private static async buryIfExhausted(job: AgentRunJob, reason: string): Promise<boolean> {
    if (job.attempt < MAX_ATTEMPTS) return false;
    await job.update({
      status: 'dead',
      workerId: null,
      leaseTokenHash: null,
      lockedUntil: null,
      lastError: `${reason} (attempt ${job.attempt}/${MAX_ATTEMPTS})`,
    });
    const run = await AgentRun.findByPk(job.runId);
    if (run && !['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      await run.update({
        status: 'failed',
        finishedAt: new Date(),
        errorMessage: `Job abandoned: ${reason} (attempt ${job.attempt}/${MAX_ATTEMPTS})`,
      });
      await AgentTask.update({ status: 'failed' }, { where: { id: run.taskId } });
    }
    await AgentPipelineService.log(job.runId, null, 'error', `Job buried: ${reason}`, {
      jobId: job.id,
      attempt: job.attempt,
    });
    return true;
  }
}
