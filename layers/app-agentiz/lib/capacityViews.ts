import { Op } from 'sequelize';
import { AgentHarnessSubscription } from '../models/AgentHarnessSubscription';
import { AgentHarnessUsageSample } from '../models/AgentHarnessUsageSample';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentWorker } from '../models/AgentWorker';
import { AgentWorkerHarness } from '../models/AgentWorkerHarness';
import { AgentCapacityService } from '../services/AgentCapacityService';

/**
 * Read-side views of the capacity subsystem, shared by the admin routes and the MCP tools so the
 * two UIs cannot drift in what they call "the state of a worker's harnesses".
 *
 * Everything here renders only the abstract contract ({key, usedPercent, resetsAt}); provider
 * `meta` is passed through untouched — a new harness gets this UI without new rendering code.
 */

export function subscriptionView(subscription: AgentHarnessSubscription) {
  return {
    id: subscription.id,
    name: subscription.name,
    provider: subscription.provider,
    authKind: subscription.authKind,
    notes: subscription.notes,
    accountId: subscription.accountId,
    resetSchedule: subscription.resetSchedule,
    stopPolicy: subscription.stopPolicy,
    alignResetEnabled: subscription.alignResetEnabled,
    alignResetHour: subscription.alignResetHour,
    alignResetTimezone: subscription.alignResetTimezone,
    windows: subscription.windows ?? [],
    exhaustedUntil: subscription.exhaustedUntil,
    exhaustedReason: subscription.exhaustedReason,
    exhausted: subscription.isExhausted(),
    lastSignalAt: subscription.lastSignalAt,
    lastSignalSource: subscription.lastSignalSource,
    lastPoke: subscription.lastPoke ?? null,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
  };
}

/**
 * The "Harness и лимиты" block of one worker: bindings, their subscriptions' state, this
 * worker's own latest sample (per worker, not per subscription — a divergence from a sibling
 * worker of the same subscription is a warning, not noise), and the jobs currently held.
 */
export async function workerHarnessView(worker: Pick<AgentWorker, 'id'>) {
  const bindings = await AgentWorkerHarness.findAll({ where: { workerId: worker.id }, order: [['harnessKey', 'ASC']] });
  const items = [] as Array<Record<string, unknown>>;
  for (const binding of bindings) {
    const subscription = binding.subscriptionId
      ? await AgentHarnessSubscription.findByPk(binding.subscriptionId)
      : null;
    const latestSample = await AgentHarnessUsageSample.findOne({
      where: { workerId: worker.id, harnessKey: binding.harnessKey },
      order: [['observedAt', 'DESC']],
    });
    const activeJobs = await AgentRunJob.count({
      where: { workerId: worker.id, harnessKey: binding.harnessKey, status: { [Op.in]: ['leased', 'running'] } },
    });
    const queuedJobs = await AgentRunJob.count({
      where: { harnessKey: binding.harnessKey, status: { [Op.in]: ['queued', 'released'] }, requiredWorkerId: worker.id },
    });
    const accountMismatch = Boolean(latestSample?.accountId && subscription?.accountId
      && latestSample.accountId !== subscription.accountId);
    items.push({
      id: binding.id,
      harnessKey: binding.harnessKey,
      enabled: binding.enabled,
      maxConcurrent: binding.maxConcurrent,
      subscription: subscription ? subscriptionView(subscription) : null,
      state: !binding.enabled ? 'disabled' : subscription?.isExhausted() ? 'exhausted' : 'available',
      latestSample: latestSample
        ? {
            observedAt: latestSample.observedAt,
            source: latestSample.source,
            windows: latestSample.windows,
            meta: latestSample.meta,
            accountId: latestSample.accountId,
          }
        : null,
      accountMismatch,
      runningJobs: activeJobs,
      queuedJobs,
    });
  }
  return items;
}

/** Usage history rows for charts/analysis: normalized windows plus provider meta as-is. */
export async function usageHistory(params: {
  workerId?: string;
  subscriptionId?: string;
  harnessKey?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}) {
  const where: Record<string | symbol, unknown> = {};
  if (params.workerId) where.workerId = params.workerId;
  if (params.subscriptionId) where.subscriptionId = params.subscriptionId;
  if (params.harnessKey) where.harnessKey = params.harnessKey;
  if (params.from || params.to) {
    where.observedAt = {
      ...(params.from ? { [Op.gte]: params.from } : {}),
      ...(params.to ? { [Op.lte]: params.to } : {}),
    };
  }
  const samples = await AgentHarnessUsageSample.findAll({
    where,
    order: [['observedAt', 'DESC']],
    limit: Math.min(Math.max(params.limit ?? 500, 1), 2000),
  });
  return samples.map((sample) => ({
    id: sample.id,
    workerId: sample.workerId,
    harnessKey: sample.harnessKey,
    subscriptionId: sample.subscriptionId,
    observedAt: sample.observedAt,
    source: sample.source,
    windows: sample.windows,
    meta: sample.meta,
    accountId: sample.accountId,
  }));
}

/**
 * One call for "why is nothing running and when will it": every subscription, every worker's
 * gated keys, and the longest-waiting parked jobs with their ETA.
 */
export async function capacityOverview() {
  const [subscriptions, workers] = await Promise.all([
    AgentHarnessSubscription.findAll({ order: [['name', 'ASC']] }),
    AgentWorker.findAll({ where: { status: { [Op.ne]: 'revoked' } }, order: [['name', 'ASC']] }),
  ]);
  const workerGates = [] as Array<Record<string, unknown>>;
  for (const worker of workers) {
    const gated = await AgentCapacityService.gatedHarnessKeys(worker);
    const bindings = await AgentWorkerHarness.findAll({ where: { workerId: worker.id } });
    workerGates.push({
      workerId: worker.id,
      name: worker.name,
      status: worker.status,
      contactState: worker.contactState(),
      maxConcurrentJobs: worker.effectiveMaxConcurrentJobs(),
      activeHours: worker.activeHours,
      timezone: worker.timezone,
      harnessKeys: bindings.map((binding) => binding.harnessKey),
      gatedHarnessKeys: gated,
    });
  }
  const waiting = await AgentRunJob.findAll({
    where: { status: { [Op.in]: ['queued', 'released'] } },
    order: [['createdAt', 'ASC']],
    limit: 20,
  });
  const waitingJobs = [] as Array<Record<string, unknown>>;
  for (const job of waiting) {
    const eta = await AgentCapacityService.nextEligibleAt(job);
    waitingJobs.push({
      jobId: job.id,
      runId: job.runId,
      projectId: job.projectId,
      status: job.status,
      harnessKey: job.harnessKey,
      deferReason: job.deferReason,
      deferredCount: job.deferredCount,
      requiredWorkerId: job.requiredWorkerId,
      availableAt: job.availableAt,
      nextEligibleAt: eta.at,
      etaIsEstimate: eta.estimate,
      etaReasons: eta.reasons,
      createdAt: job.createdAt,
    });
  }
  return {
    subscriptions: subscriptions.map(subscriptionView),
    workers: workerGates,
    waitingJobs,
    timestamp: new Date().toISOString(),
  };
}
