import { AgentHarnessSubscription } from '../models/AgentHarnessSubscription';
import { AgentProject } from '../models/AgentProject';
import { AgentRun } from '../models/AgentRun';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentWorker } from '../models/AgentWorker';
import { AgentWorkerHarness } from '../models/AgentWorkerHarness';
import { classifyHarnessFailure } from '../lib/harnessLimits';
import type { HarnessLimitSignal } from '../lib/harnessLimits';
import { harnessKeyForStage } from '../lib/harness';
import type { StageAgentRef } from '../lib/harness';
import { sendDashboardNotification } from '../lib/notifications/dashboardNotifications';
import { formatUserDeadline, userTimezoneById } from '../lib/userTime';
import { AgentCapacityService } from './AgentCapacityService';
import { AgentPipelineService } from './AgentPipelineService';
import { AgentRunInteractionService } from './AgentRunInteractionService';

/**
 * Separate deferral budget, counted apart from `attempt`: a defer refunds the claim's attempt
 * increment, so a weekly limit cannot bury a job on its fifth week, and this cap is what stops a
 * job that defers forever instead.
 */
const MAX_DEFERRALS = Number(process.env.AGENTIZ_JOB_MAX_DEFERRALS ?? 50);
/** Deferrals shorter than this are not worth a bell notification. */
const DEFER_NOTIFY_MIN_MS = Number(process.env.AGENTIZ_DEFER_NOTIFY_MIN ?? 30 * 60_000);

/** How soon an unpinned deferred job re-enters the queue: another worker may take it right away. */
const UNPINNED_RETRY_MS = 3 * 60_000;
/** A pinned job never retries sooner than this, even when the reset time is already past. */
const PINNED_RETRY_MIN_MS = 2 * 60_000;

interface SnapshotStage {
  executionId?: string | null;
  role?: string;
  agent?: StageAgentRef | null;
}

export interface ClassifiedLimit {
  harnessKey: string;
  signal: HarnessLimitSignal;
}

export interface DeferredOutcome {
  retryAt: Date;
  exhaustedUntil: Date;
}

/**
 * Turns a failed pipeline result into a deferral when the failure is a harness limit.
 *
 * This is the server-side insertion point the design chose deliberately: classification happens
 * where the result is received, so recognizing a limit needs no worker release — patterns update
 * with a layer deploy, and the in-process worker gets the same behaviour for free.
 */
export class AgentRunDeferService {
  /**
   * Classifies a failed pipeline job's error text against the provider of the failed stage's
   * harness. Null = not a limit (or no provider) — the caller proceeds with the normal failed
   * path unchanged.
   */
  static async classify(
    job: AgentRunJob,
    worker: Pick<AgentWorker, 'id' | 'name' | 'hostname' | 'timezone' | 'capabilities'>,
    errorText: string,
    completedExecutionIds: string[] = [],
  ): Promise<ClassifiedLimit | null> {
    if (!errorText.trim()) return null;
    if (job.deferredCount >= MAX_DEFERRALS) {
      console.warn(`[AgentizDefer] job ${job.id} exceeded ${MAX_DEFERRALS} deferrals; failing normally`);
      return null;
    }
    const harnessKey = this.failedStageHarnessKey(job, completedExecutionIds);
    if (!harnessKey) return null;
    // The existing binding's subscription provides context (authKind changes how a provider reads
    // a refusal); deliberately no auto-creation here — rows appear only for actual limit signals.
    const binding = await AgentWorkerHarness.findOne({ where: { workerId: worker.id, harnessKey } });
    const subscription = binding?.subscriptionId
      ? await AgentHarnessSubscription.findByPk(binding.subscriptionId)
      : null;
    const signal = classifyHarnessFailure(harnessKey, errorText, AgentCapacityService.providerContext(worker, subscription));
    return signal ? { harnessKey, signal } : null;
  }

  /**
   * Parks the job and the run instead of failing them: subscription gate closes, the job returns
   * to the queue as `released` with the attempt increment refunded, the run keeps its
   * non-terminal status and gets the waiting badge. The two resume triggers are both automatic —
   * the reaper once `availableAt` passes, and `recoverSubscription` on any early recovery.
   */
  static async defer(params: {
    job: AgentRunJob;
    run: AgentRun;
    worker: Pick<AgentWorker, 'id' | 'name'>;
    classified: ClassifiedLimit;
    errorText: string;
  }): Promise<DeferredOutcome> {
    const { job, run, worker, classified, errorText } = params;
    const now = new Date();
    const { exhaustedUntil } = await AgentCapacityService.recordLimitSignal({
      worker,
      harnessKey: classified.harnessKey,
      signal: classified.signal,
      errorText,
      deferredCount: job.deferredCount,
    });

    // Pinned = nobody else can run it, so it waits for the actual reset ("the task legitimately
    // waits a week"). Unpinned = short backoff; the closed gate protects it from this worker and
    // any other worker with a live subscription may take it immediately.
    const pinned = Boolean(job.requiredWorkerId);
    const retryAt = pinned
      ? new Date(Math.max(exhaustedUntil.getTime(), now.getTime() + PINNED_RETRY_MIN_MS))
      : new Date(now.getTime() + UNPINNED_RETRY_MS);

    await AgentRunInteractionService.closeForJob(job, 'orphaned', `deferred: ${classified.signal.matched}`);
    await job.update({
      status: 'released',
      workerId: null,
      leaseTokenHash: null,
      lockedUntil: null,
      availableAt: retryAt,
      deferReason: 'harness_limit',
      deferredCount: job.deferredCount + 1,
      // Refund the claim's increment: a legal wait must not spend the retry budget.
      attempt: Math.max(job.attempt - 1, 0),
      lastError: errorText,
    });
    const waitingUntil = pinned ? retryAt : exhaustedUntil;
    await run.update({ waitingReason: 'harness_limit', waitingUntil });
    await AgentPipelineService.log(run.id, run.projectId, null, 'warn',
      `Run отложен: лимит ${classified.harnessKey} на воркере ${worker.name}, продолжение ~${formatUserDeadline(waitingUntil)}`,
      { jobId: job.id, deferredCount: job.deferredCount + 1, matched: classified.signal.matched, retryAt: retryAt.toISOString() });

    if (waitingUntil.getTime() - now.getTime() >= DEFER_NOTIFY_MIN_MS) {
      const project = await AgentProject.findByPk(run.projectId);
      // The notification is addressed to the project owner, so the deadline reads in *their* zone.
      const ownerTimezone = await userTimezoneById(project?.ownerId);
      void sendDashboardNotification({
        channel: 'run-deferred',
        title: `Run отложен: лимит ${classified.harnessKey}`,
        message: `Воркер ${worker.name}, продолжение ~${formatUserDeadline(waitingUntil, ownerTimezone)}`,
        userId: project?.ownerId ?? undefined,
        metadata: { runId: run.id, jobId: job.id, harnessKey: classified.harnessKey },
      });
    }
    return { retryAt, exhaustedUntil };
  }

  /**
   * The harness of the stage that failed: the first stage whose execution the worker did not
   * report as completed. For `mixed` jobs this yields the exact key, so the coarse column is
   * never consulted here.
   */
  private static failedStageHarnessKey(job: AgentRunJob, completedExecutionIds: string[]): string | null {
    const stages = (job.snapshot?.stages as SnapshotStage[] | undefined) ?? [];
    const completed = new Set(completedExecutionIds);
    const failedStage = stages.find((stage) => !stage.executionId || !completed.has(stage.executionId)) ?? stages[0];
    return harnessKeyForStage(failedStage?.agent);
  }
}
