import { Op, literal } from 'sequelize';
import { createHash } from 'crypto';
import { AgentRun } from '../models/AgentRun';
import { AgentRunJob } from '../models/AgentRunJob';
import type { AgentWorker } from '../models/AgentWorker';
import { isScheduleOpen, nextScheduleOpen } from '../lib/activeHours';
import { MIXED_HARNESS_KEY } from '../lib/harness';
import { AgentCapacityService } from './AgentCapacityService';
import { AgentPipelineService } from './AgentPipelineService';

/** How many locked candidates one claim walks before giving up; JS-side checks skip within them. */
const CANDIDATE_BATCH = 5;

export interface ClaimOptions {
  /**
   * `lease` is the remote Worker API: the job is handed out under a lease token and heartbeats.
   * `local` is the in-process drainer: no lease, the job goes straight to `running`.
   */
  mode: 'lease' | 'local';
  /** Lease/lock lifetime for the chosen mode. */
  lockMs: number;
  /** Precomputed lease token hash (`lease` mode). */
  leaseTokenHash?: string;
  /** Restrict claimable job kinds; the local drainer and non-workspaceGit workers only run pipelines. */
  pipelineOnly: boolean;
}

export interface ClaimOutcome {
  job: AgentRunJob | null;
  /** When the worker could next be eligible, as a polling hint — set only on some empty claims. */
  nextEligibleAt?: Date;
}

export function hashLeaseToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The one claim implementation both claim sites call — `AgentWorkerApiService.claim()` and
 * `AgentWorkerQueueService.claimLocalJob()`. The project rule used to be "add every new filter to
 * both places"; with harness gates, concurrency and schedule windows joining the allowlists, that
 * discipline is closed structurally instead.
 *
 * The split of responsibilities it enforces:
 *  - `availableAt` carries only the job's *own* properties (its schedule window, its backoff, its
 *    pinned resume time) — things independent of who is claiming;
 *  - worker-side gates (exhausted subscription, disabled binding, the machine's activeHours,
 *    concurrency) live here, in the claim, and are never written into `availableAt` — an unpinned
 *    job deferred by worker A's limit must go to worker B immediately.
 */
export class AgentJobClaimService {
  static async claim(worker: AgentWorker, options: ClaimOptions): Promise<ClaimOutcome> {
    const now = new Date();

    // The machine's own service window: closed means no SQL at all, and the caller can surface
    // the reopening time as a polling hint.
    if (!isScheduleOpen(worker.activeHours, now)) {
      return { job: null, nextEligibleAt: nextScheduleOpen(worker.activeHours, now) };
    }

    const sequelize = AgentRunJob.sequelize;
    if (!sequelize) throw new Error('Sequelize is not initialized');

    const allowedProjectIds = worker.allowedProjectIds?.length ? worker.allowedProjectIds : null;
    const allowedRepositoryIds = worker.allowedRepositoryIds?.length ? worker.allowedRepositoryIds : null;
    const gatedKeys = await AgentCapacityService.gatedHarnessKeys(worker, now);
    const maxConcurrent = worker.effectiveMaxConcurrentJobs();

    const job = await sequelize.transaction(async (transaction) => {
      // Serializes competing claims of one worker (two processes holding the same token) —
      // without it the concurrency check races on "both saw 0 running". Free on sqlite, where
      // there is a single writer anyway.
      const WorkerModel = worker.constructor as typeof AgentWorker;
      await WorkerModel.findByPk(worker.id, { transaction, lock: transaction.LOCK.UPDATE });

      // Concurrency as a literal correlated subquery: portable between postgres and sqlite, and
      // correct under the worker-row lock above. Ids are our own UUIDs but escaped anyway.
      const workerIdLiteral = sequelize.escape(worker.id);
      const concurrencyGate = literal(
        `(SELECT COUNT(*) FROM agentiz_run_jobs AS j2 WHERE j2."workerId" = ${workerIdLiteral} AND j2.status IN ('leased', 'running')) < ${maxConcurrent}`,
      );

      const conditions: Record<string | symbol, unknown>[] = [
        { status: 'queued' },
        { availableAt: { [Op.lte]: now } },
        // A job pinned to a worker directory belongs to that machine alone; everyone else must
        // not even see it, or it would be claimed and then fail for a missing path.
        { [Op.or]: [{ requiredWorkerId: null }, { requiredWorkerId: worker.id }] },
        { [Op.and]: [concurrencyGate] },
      ];
      // The allowlist is enforced in the claim query itself: a worker cannot even see a snapshot
      // of a project or repository it was not granted.
      if (allowedProjectIds) conditions.push({ projectId: { [Op.in]: allowedProjectIds } });
      if (allowedRepositoryIds) {
        conditions.push({ [Op.or]: [{ repositoryId: null }, { repositoryId: { [Op.in]: allowedRepositoryIds } }] });
      }
      if (options.pipelineOnly) conditions.push({ jobKind: 'pipeline' });
      if (gatedKeys.length > 0) {
        // Flat NOT IN over a STRING column — identical in postgres and sqlite. `mixed` is
        // excluded conservatively here; its exact key list is checked in JS below. NULL keys
        // (git-only jobs) pass: git operations spend no tokens, and blocking a workspace unlock
        // behind an exhausted Claude would be a bug.
        conditions.push({ [Op.or]: [{ harnessKey: null }, { harnessKey: { [Op.notIn]: [...gatedKeys, MIXED_HARNESS_KEY] } }] });
      }

      const candidates = await AgentRunJob.findAll({
        where: { [Op.and]: conditions },
        order: [['priority', 'ASC'], ['createdAt', 'ASC']],
        limit: CANDIDATE_BATCH,
        transaction,
        lock: transaction.LOCK.UPDATE,
        skipLocked: true,
      });

      for (const candidate of candidates) {
        // Exact `mixed` check against the snapshot's full key list — SQL only sees the column.
        if (gatedKeys.length > 0 && candidate.harnessKey === MIXED_HARNESS_KEY) {
          const keys = AgentCapacityService.jobHarnessKeys(candidate);
          if (keys.some((key) => gatedKeys.includes(key))) continue;
        }
        // Window freshness, in case the capacity sweep has not caught this job yet: a candidate
        // whose window closed heals its own availableAt instead of waiting for the sweep.
        if (candidate.scheduleWindow && !isScheduleOpen(candidate.scheduleWindow, now)) {
          await candidate.update({
            availableAt: nextScheduleOpen(candidate.scheduleWindow, now),
            deferReason: 'schedule_window',
          }, { transaction });
          continue;
        }

        await candidate.update({
          status: options.mode === 'lease' ? 'leased' : 'running',
          workerId: worker.id,
          attempt: candidate.attempt + 1,
          leaseTokenHash: options.mode === 'lease' ? options.leaseTokenHash ?? null : null,
          lockedUntil: new Date(now.getTime() + options.lockMs),
          lastError: null,
        }, { transaction });
        return candidate;
      }
      return null;
    });

    if (!job) return { job: null };
    await this.noteResumedAfterDeferral(job, worker);
    return { job };
  }

  /**
   * Continuation is recorded explicitly: a job claimed with a `deferReason` writes the
   * "продолжен" line, so the run history keeps the deferred → resumed pair and how long the task
   * stood waiting is visible after the fact.
   */
  private static async noteResumedAfterDeferral(job: AgentRunJob, worker: AgentWorker): Promise<void> {
    if (!job.deferReason) return;
    const reason = job.deferReason;
    await job.update({ deferReason: null });
    const run = await AgentRun.findByPk(job.runId);
    const waitedMs = run?.waitingUntil ? Math.max(Date.now() - new Date(run.updatedAt).getTime(), 0) : null;
    const waitedText = waitedMs !== null && waitedMs > 60_000 ? ` (ждал ${formatDuration(waitedMs)})` : '';
    await AgentPipelineService.log(job.runId, job.projectId, null, 'info',
      reason === 'harness_limit'
        ? `Run продолжен после ожидания лимита${waitedText} на воркере ${worker.name}`
        : `Run продолжен после открытия окна рабочего времени на воркере ${worker.name}`,
      { jobId: job.id, deferReason: reason, deferredCount: job.deferredCount });
  }
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${days}д ${hours}ч`;
  if (hours > 0) return `${hours}ч ${rest}м`;
  return `${rest}м`;
}
