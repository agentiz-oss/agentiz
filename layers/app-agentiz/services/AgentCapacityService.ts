import { Op } from 'sequelize';
import { AgentHarnessSubscription } from '../models/AgentHarnessSubscription';
import { AgentHarnessUsageSample } from '../models/AgentHarnessUsageSample';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentWorker } from '../models/AgentWorker';
import { AgentWorkerHarness } from '../models/AgentWorkerHarness';
import { harnessLimitProviderFor, listHarnessLimitProviders } from '../lib/harnessLimits';
import type { HarnessLimitProviderContext, HarnessLimitSignal, HarnessLimitSnapshot } from '../lib/harnessLimits';
import { isScheduleOpen, nextScheduleOpen, nextWeeklyMoment, prevWeeklyMoment } from '../lib/activeHours';
import { MIXED_HARNESS_KEY } from '../lib/harness';
import { sendDashboardNotification } from '../lib/notifications/dashboardNotifications';
import type { HarnessSignalSource, HarnessWindowState } from '../types/agentiz';

/** How often the capacity sweep runs (schedule windows, declared resets). */
const SWEEP_INTERVAL_MS = Number(process.env.AGENTIZ_CAPACITY_SWEEP_MS ?? 30_000);
/** How often the provider refresh cycle and sample retention run, inside the sweep. */
const USAGE_POLL_MS = Number(process.env.AGENTIZ_USAGE_POLL_MS ?? 300_000);
const SAMPLE_RETENTION_DAYS = Number(process.env.AGENTIZ_USAGE_SAMPLE_RETENTION_DAYS ?? 30);

/**
 * Deferral backoff for a limit whose reset time nobody named: 15m → 1h → 4h → 12h. The ceiling is
 * configurable because a wrong guess only costs a canary claim when it expires.
 */
const BACKOFF_LADDER_MS = [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000, 12 * 60 * 60_000];
const BACKOFF_CEILING_MS = Number(process.env.AGENTIZ_DEFER_BACKOFF_MAX_MS ?? BACKOFF_LADDER_MS[BACKOFF_LADDER_MS.length - 1]);

/** `resumeAt` comes out of parsed refusal text, so it is clamped before anything trusts it. */
const RESUME_CLAMP_MIN_MS = 60_000;
const RESUME_CLAMP_MAX_MS = 8 * 24 * 60 * 60_000;

// The gate cache hangs off a global symbol for the same reason every registry here does: under
// tsx this module can exist twice, and a cache invalidated in one copy must not survive in the other.
const GATE_CACHE_KEY = Symbol.for('agentiz.capacity.gateCache');
const GATE_CACHE_TTL_MS = 5_000;

type GateCache = Map<string, { keys: string[]; expiresAt: number }>;

function gateCache(): GateCache {
  const holder = globalThis as unknown as Record<symbol, GateCache>;
  if (!holder[GATE_CACHE_KEY]) holder[GATE_CACHE_KEY] = new Map();
  return holder[GATE_CACHE_KEY];
}

function clampResumeAt(resumeAt: Date, now: Date): Date {
  const value = resumeAt.getTime();
  const min = now.getTime() + RESUME_CLAMP_MIN_MS;
  const max = now.getTime() + RESUME_CLAMP_MAX_MS;
  return new Date(Math.min(Math.max(value, min), max));
}

function backoffMs(deferredCount: number): number {
  const step = BACKOFF_LADDER_MS[Math.min(Math.max(deferredCount, 0), BACKOFF_LADDER_MS.length - 1)];
  return Math.min(step, Math.max(BACKOFF_CEILING_MS, BACKOFF_LADDER_MS[0]));
}

/** Marker prefix that lets a later snapshot distinguish a preventive stop from a real refusal. */
const PREVENTIVE_REASON_PREFIX = 'Preventive stop:';

export interface LimitSignalOutcome {
  subscription: AgentHarnessSubscription;
  binding: AgentWorkerHarness;
  exhaustedUntil: Date;
}

export interface AppliedSnapshotOutcome {
  subscription: AgentHarnessSubscription | null;
  sample: AgentHarnessUsageSample;
  warnings: string[];
}

/**
 * The single write point of the capacity subsystem: every path that learns something about a
 * subscription's limits — a classified failure, an external usage report, a provider refresh, an
 * operator's hand, a declared reset schedule — goes through here, so cache invalidation, sample
 * history and notifications cannot be skipped by one of them.
 *
 * The split it enforces: `subscription.windows` is advisory telemetry, `exhaustedUntil` is the
 * only field the claim gate reads. Telemetry reaches enforcement through `stopPolicy` thresholds
 * and classified failures only, and a percentage never re-opens a gate a refusal closed.
 */
export class AgentCapacityService {
  private static timer: NodeJS.Timeout | null = null;
  private static running = false;
  private static lastUsageCycleAt = 0;

  static start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweepOnce().catch((error) => {
        console.error('[AgentizCapacity] sweep failed:', error);
      });
    }, Math.max(SWEEP_INTERVAL_MS, 5_000));
    this.timer.unref?.();
    console.log(`[AgentizCapacity] started (sweep every ${Math.max(SWEEP_INTERVAL_MS, 5_000)}ms, usage cycle every ${USAGE_POLL_MS}ms)`);
  }

  static stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  static invalidateGateCache(): void {
    gateCache().clear();
  }

  /**
   * Harness keys this worker must not receive right now: bindings switched off by an operator and
   * bindings whose subscription is exhausted (including preventively). Read by the claim gate on
   * every claim, hence the small cache.
   */
  static async gatedHarnessKeys(worker: Pick<AgentWorker, 'id'>, now: Date = new Date()): Promise<string[]> {
    const cache = gateCache();
    const cached = cache.get(worker.id);
    if (cached && cached.expiresAt > now.getTime()) return cached.keys;
    const bindings = await AgentWorkerHarness.findAll({ where: { workerId: worker.id } });
    const keys: string[] = [];
    for (const binding of bindings) {
      if (!binding.enabled) {
        keys.push(binding.harnessKey);
        continue;
      }
      if (!binding.subscriptionId) continue;
      const subscription = await AgentHarnessSubscription.findByPk(binding.subscriptionId);
      if (subscription?.isExhausted(now)) keys.push(binding.harnessKey);
    }
    cache.set(worker.id, { keys, expiresAt: now.getTime() + GATE_CACHE_TTL_MS });
    return keys;
  }

  /**
   * The binding for `worker × harnessKey`, auto-created on first contact — with an implicit
   * subscription `<worker>/<harness>` when none is assigned — so claim logic and limit state
   * always go through a subscription, without branches and without losing a signal to an
   * unfilled directory.
   */
  static async ensureBinding(
    worker: Pick<AgentWorker, 'id' | 'name'>,
    harnessKey: string,
  ): Promise<{ binding: AgentWorkerHarness; subscription: AgentHarnessSubscription }> {
    let binding = await AgentWorkerHarness.findOne({ where: { workerId: worker.id, harnessKey } });
    if (!binding) {
      binding = await AgentWorkerHarness.create({ workerId: worker.id, harnessKey, enabled: true });
    }
    let subscription = binding.subscriptionId
      ? await AgentHarnessSubscription.findByPk(binding.subscriptionId)
      : null;
    if (!subscription) {
      subscription = await AgentHarnessSubscription.create({
        name: `${worker.name}/${harnessKey}`,
        provider: harnessKey === 'claude' ? 'anthropic' : harnessKey === 'codex' ? 'openai' : 'other',
        authKind: 'subscription',
      });
      await binding.update({ subscriptionId: subscription.id });
    }
    return { binding, subscription };
  }

  /** Provider context for one worker; what a provider is allowed to know. */
  static providerContext(
    worker: Pick<AgentWorker, 'id' | 'name' | 'hostname' | 'timezone' | 'capabilities'>,
    subscription: AgentHarnessSubscription | null,
  ): HarnessLimitProviderContext {
    return {
      worker: {
        id: worker.id,
        name: worker.name,
        hostname: worker.hostname ?? null,
        timezone: worker.timezone ?? (typeof worker.capabilities?.timezone === 'string' ? worker.capabilities.timezone : null),
      },
      subscription: subscription ? { id: subscription.id, authKind: subscription.authKind } : null,
    };
  }

  /**
   * A classified refusal: closes the subscription's gate and records the hit in the sample
   * history (`usedPercent: 100` — the impacts themselves are visible on the chart). Returns when
   * work may resume, for the caller to park the job with.
   */
  static async recordLimitSignal(params: {
    worker: Pick<AgentWorker, 'id' | 'name'>;
    harnessKey: string;
    signal: HarnessLimitSignal;
    errorText: string;
    /** The job's deferral count before this signal — indexes the backoff ladder. */
    deferredCount: number;
  }): Promise<LimitSignalOutcome> {
    const now = new Date();
    const { binding, subscription } = await this.ensureBinding(params.worker, params.harnessKey);

    const scheduled = this.nextDeclaredReset(subscription, now);
    const exhaustedUntil = params.signal.resumeAt
      ? clampResumeAt(params.signal.resumeAt, now)
      : scheduled ?? new Date(now.getTime() + backoffMs(params.deferredCount));

    // A refusal always outranks whatever the gate held before — including a longer preventive
    // stop: the provider's own message is the freshest truth about this subscription.
    await subscription.update({
      exhaustedUntil,
      exhaustedReason: `${params.signal.matched}: ${params.errorText}`.slice(0, 4000),
      lastSignalAt: now,
      lastSignalSource: 'failure',
    });
    await AgentHarnessUsageSample.create({
      workerId: params.worker.id,
      harnessKey: params.harnessKey,
      subscriptionId: subscription.id,
      observedAt: now,
      source: 'failure',
      windows: [{
        key: params.signal.windowKey ?? 'unknown',
        usedPercent: 100,
        resetsAt: exhaustedUntil.toISOString(),
        observedAt: now.toISOString(),
        source: 'failure',
      }],
      meta: { matched: params.signal.matched, kind: params.signal.kind },
      accountId: null,
    });
    this.invalidateGateCache();
    void sendDashboardNotification({
      channel: 'harness-limit',
      title: `Лимит ${params.harnessKey} исчерпан на воркере ${params.worker.name}`,
      message: `Подписка «${subscription.name}» закрыта до ${exhaustedUntil.toLocaleString('ru-RU')}`,
      metadata: { subscriptionId: subscription.id, workerId: params.worker.id, harnessKey: params.harnessKey },
    });
    return { subscription, binding, exhaustedUntil };
  }

  /**
   * Applies one telemetry snapshot from any source. Always leaves a sample row; updates the
   * subscription's cached `windows`; applies `stopPolicy` (threshold reached ⇒ preventive
   * `exhaustedUntil` until that window's reset); and clears a *preventive* stop whose windows
   * have dropped back below threshold — never one set by an actual refusal.
   */
  static async applySnapshot(params: {
    workerId?: string | null;
    subscriptionId?: string | null;
    harnessKey: string;
    snapshot: HarnessLimitSnapshot;
    source: HarnessSignalSource;
    observedAt?: Date;
  }): Promise<AppliedSnapshotOutcome> {
    const now = new Date();
    const observedAt = params.observedAt ?? now;
    const warnings: string[] = [];

    let subscription: AgentHarnessSubscription | null = null;
    let workerId = params.workerId ?? null;
    if (params.subscriptionId) {
      subscription = await AgentHarnessSubscription.findByPk(params.subscriptionId);
      if (!subscription) throw new Error(`AgentHarnessSubscription ${params.subscriptionId} not found`);
    } else if (workerId) {
      const worker = await AgentWorker.findByPk(workerId);
      if (!worker) throw new Error(`AgentWorker ${workerId} not found`);
      ({ subscription } = await this.ensureBinding(worker, params.harnessKey));
    }

    const windows: HarnessWindowState[] = (params.snapshot.windows ?? []).map((window) => ({
      key: window.key,
      label: window.label,
      usedPercent: typeof window.usedPercent === 'number'
        ? Math.min(Math.max(window.usedPercent, 0), 100)
        : undefined,
      resetsAt: window.resetsAt ? new Date(window.resetsAt).toISOString() : null,
      observedAt: observedAt.toISOString(),
      source: params.source,
    }));

    const sample = await AgentHarnessUsageSample.create({
      workerId,
      harnessKey: params.harnessKey,
      subscriptionId: subscription?.id ?? null,
      observedAt,
      source: params.source,
      windows,
      meta: params.snapshot.meta ?? null,
      accountId: params.snapshot.accountId ?? null,
    });

    if (subscription) {
      // Merge by window key so a partial report does not erase what another window last said.
      const merged = new Map<string, HarnessWindowState>();
      for (const existing of subscription.windows ?? []) merged.set(existing.key, existing);
      for (const window of windows) merged.set(window.key, { ...merged.get(window.key), ...window });
      const updates: Partial<{
        windows: HarnessWindowState[];
        accountId: string | null;
        lastSignalAt: Date;
        lastSignalSource: HarnessSignalSource;
      }> = {
        windows: [...merged.values()],
        lastSignalAt: now,
        lastSignalSource: params.source,
      };
      if (params.snapshot.accountId) {
        if (!subscription.accountId) {
          updates.accountId = params.snapshot.accountId;
        } else if (subscription.accountId !== params.snapshot.accountId) {
          // Auto-binding never re-binds silently: a mismatch is a diagnosis for the operator.
          warnings.push(`Report carries accountId "${params.snapshot.accountId}" but subscription "${subscription.name}" is bound to "${subscription.accountId}"`);
        }
      }
      await subscription.update(updates);
      await this.applyStopPolicy(subscription, now, warnings);
      this.invalidateGateCache();
    }

    return { subscription, sample, warnings };
  }

  /** Operator's hand or a declared schedule: close the gate until `until`. */
  static async markExhausted(
    subscriptionId: string,
    until: Date,
    reason: string,
    source: HarnessSignalSource = 'manual',
  ): Promise<AgentHarnessSubscription> {
    const subscription = await AgentHarnessSubscription.findByPk(subscriptionId);
    if (!subscription) throw new Error(`AgentHarnessSubscription ${subscriptionId} not found`);
    await subscription.update({
      exhaustedUntil: until,
      exhaustedReason: reason,
      lastSignalAt: new Date(),
      lastSignalSource: source,
    });
    this.invalidateGateCache();
    return subscription;
  }

  /** Any removal/shortening of `exhaustedUntil` funnels into recoverSubscription. */
  static async clearLimit(subscriptionId: string, reason: string, source: HarnessSignalSource = 'manual'): Promise<AgentHarnessSubscription> {
    const subscription = await AgentHarnessSubscription.findByPk(subscriptionId);
    if (!subscription) throw new Error(`AgentHarnessSubscription ${subscriptionId} not found`);
    await subscription.update({
      exhaustedUntil: null,
      exhaustedReason: null,
      lastSignalAt: new Date(),
      lastSignalSource: source,
    });
    await this.recoverSubscription(subscription, reason);
    return subscription;
  }

  /**
   * The event-driven resume path: wakes jobs that were parked waiting for this subscription.
   * Pinned jobs sleep until their old `resumeAt` otherwise — tokens arriving early must continue
   * the work immediately, not on last week's forecast. Unpinned jobs already sit on a short
   * backoff and need no waking.
   */
  static async recoverSubscription(subscription: AgentHarnessSubscription, cause: string): Promise<number> {
    this.invalidateGateCache();
    const bindings = await AgentWorkerHarness.findAll({ where: { subscriptionId: subscription.id } });
    const workerIds = [...new Set(bindings.map((binding) => binding.workerId))];
    let woken = 0;
    if (workerIds.length > 0) {
      const now = new Date();
      const [count] = await AgentRunJob.update({ availableAt: now }, {
        where: {
          status: { [Op.in]: ['released', 'queued'] },
          deferReason: 'harness_limit',
          requiredWorkerId: { [Op.in]: workerIds },
          availableAt: { [Op.gt]: now },
        },
      });
      woken = count;
    }
    void sendDashboardNotification({
      channel: 'harness-limit',
      title: `Подписка «${subscription.name}» восстановлена`,
      message: woken > 0 ? `Продолжаем ${woken} задач(и): ${cause}` : cause,
      metadata: { subscriptionId: subscription.id, wokenJobs: woken },
    });
    return woken;
  }

  /**
   * Periodic upkeep: closed schedule windows push queued jobs' `availableAt` forward, declared
   * subscription resets clear `exhaustedUntil`, and — on the slower usage cadence — providers
   * with `refresh()` are polled and old samples are dropped.
   */
  static async sweepOnce(): Promise<{ movedWindows: number; resetSubscriptions: number }> {
    if (this.running) return { movedWindows: 0, resetSubscriptions: 0 };
    this.running = true;
    try {
      const movedWindows = await this.sweepScheduleWindows();
      const resetSubscriptions = await this.sweepDeclaredResets();
      if (Date.now() - this.lastUsageCycleAt >= USAGE_POLL_MS) {
        this.lastUsageCycleAt = Date.now();
        await this.runRefreshCycle();
        await this.sweepSampleRetention();
      }
      return { movedWindows, resetSubscriptions };
    } finally {
      this.running = false;
    }
  }

  /** ETA of one job, for UI/MCP: when it can actually be claimed, and whether that is exact. */
  static async nextEligibleAt(job: AgentRunJob, now: Date = new Date()): Promise<{ at: Date; estimate: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    let at = job.availableAt && job.availableAt.getTime() > now.getTime() ? new Date(job.availableAt) : now;
    if (job.scheduleWindow && !isScheduleOpen(job.scheduleWindow, at)) {
      at = nextScheduleOpen(job.scheduleWindow, at);
      reasons.push('schedule_window');
    }
    let estimate = true;
    if (job.requiredWorkerId) {
      estimate = false;
      const keys = this.jobHarnessKeys(job);
      for (const key of keys) {
        const binding = await AgentWorkerHarness.findOne({ where: { workerId: job.requiredWorkerId, harnessKey: key } });
        if (!binding?.subscriptionId) continue;
        const subscription = await AgentHarnessSubscription.findByPk(binding.subscriptionId);
        if (subscription?.exhaustedUntil && subscription.exhaustedUntil.getTime() > at.getTime()) {
          at = new Date(subscription.exhaustedUntil);
          reasons.push(`harness_limit:${key}`);
        }
      }
    }
    return { at, estimate, reasons };
  }

  /** The harness keys a job is gated by: the column, or the snapshot list for `mixed`. */
  static jobHarnessKeys(job: Pick<AgentRunJob, 'harnessKey' | 'snapshot'>): string[] {
    if (!job.harnessKey) return [];
    if (job.harnessKey !== MIXED_HARNESS_KEY) return [job.harnessKey];
    const listed = (job.snapshot as { harnessKeys?: unknown })?.harnessKeys;
    return Array.isArray(listed) ? listed.filter((key): key is string => typeof key === 'string') : [job.harnessKey];
  }

  private static nextDeclaredReset(subscription: AgentHarnessSubscription, now: Date): Date | null {
    const schedule = subscription.resetSchedule;
    if (!schedule || schedule.kind !== 'weekly') return null;
    return nextWeeklyMoment(schedule.day, schedule.time, schedule.timezone, now);
  }

  /**
   * `stopPolicy` on the freshly merged windows: a window at/over its threshold closes the gate
   * until that window's reset (only when the reset time is known — a preventive stop with no end
   * would be a manual lock in disguise). The inverse — every policed window back below its
   * threshold — releases only a stop this same mechanism set.
   */
  private static async applyStopPolicy(subscription: AgentHarnessSubscription, now: Date, warnings: string[]): Promise<void> {
    const policy = subscription.stopPolicy;
    if (!policy) return;
    const windows = subscription.windows ?? [];
    let worstUntil: Date | null = null;
    let worstReason: string | null = null;
    for (const [key, rule] of Object.entries(policy)) {
      const threshold = rule?.pauseAtUsedPercent;
      if (typeof threshold !== 'number') continue;
      const window = windows.find((item) => item.key === key);
      if (!window || typeof window.usedPercent !== 'number' || window.usedPercent < threshold) continue;
      if (!window.resetsAt) {
        warnings.push(`Window "${key}" is at ${window.usedPercent}% (≥ ${threshold}%) but reports no reset time; not stopping preventively`);
        continue;
      }
      const until = new Date(window.resetsAt);
      if (until.getTime() <= now.getTime()) continue;
      if (!worstUntil || until.getTime() > worstUntil.getTime()) {
        worstUntil = until;
        worstReason = `${PREVENTIVE_REASON_PREFIX} ${key} ${Math.round(window.usedPercent)}% ≥ ${threshold}%`;
      }
    }

    const currentlyPreventive = subscription.exhaustedReason?.startsWith(PREVENTIVE_REASON_PREFIX) ?? false;
    if (worstUntil) {
      // Never shorten a refusal-set gate: a refusal always outranks telemetry.
      if (!subscription.isExhausted(now) || (currentlyPreventive && worstUntil.getTime() > (subscription.exhaustedUntil?.getTime() ?? 0))) {
        await subscription.update({ exhaustedUntil: worstUntil, exhaustedReason: worstReason });
        void sendDashboardNotification({
          channel: 'harness-limit',
          title: `Подписка «${subscription.name}» остановлена превентивно`,
          message: `${worstReason}, до ${worstUntil.toLocaleString('ru-RU')}`,
          metadata: { subscriptionId: subscription.id },
        });
      }
      return;
    }
    if (currentlyPreventive && subscription.isExhausted(now)) {
      await subscription.update({ exhaustedUntil: null, exhaustedReason: null });
      await this.recoverSubscription(subscription, 'телеметрия опустилась ниже порога stopPolicy');
    }
  }

  /**
   * The claim's candidate check heals windows one job at a time; this is the wholesale version so
   * a queue nobody polls still shows honest `availableAt`s.
   */
  private static async sweepScheduleWindows(): Promise<number> {
    const now = new Date();
    const jobs = await AgentRunJob.findAll({
      where: {
        status: 'queued',
        scheduleWindow: { [Op.ne]: null },
        availableAt: { [Op.lte]: now },
      },
      limit: 200,
    });
    let moved = 0;
    for (const job of jobs) {
      if (isScheduleOpen(job.scheduleWindow, now)) continue;
      const nextOpen = nextScheduleOpen(job.scheduleWindow, now);
      if (nextOpen.getTime() <= now.getTime()) continue;
      await job.update({ availableAt: nextOpen, deferReason: 'schedule_window' });
      moved += 1;
    }
    return moved;
  }

  /** A declared reset that has occurred since the limit was set opens the gate by itself. */
  private static async sweepDeclaredResets(): Promise<number> {
    const now = new Date();
    const subscriptions = await AgentHarnessSubscription.findAll({
      where: { exhaustedUntil: { [Op.ne]: null, [Op.gt]: now } },
    });
    let reset = 0;
    for (const subscription of subscriptions) {
      const schedule = subscription.resetSchedule;
      if (!schedule || schedule.kind !== 'weekly') continue;
      const lastReset = prevWeeklyMoment(schedule.day, schedule.time, schedule.timezone, now);
      const setAt = subscription.lastSignalAt ?? subscription.updatedAt;
      if (!lastReset || !setAt || lastReset.getTime() <= new Date(setAt).getTime()) continue;
      await subscription.update({
        exhaustedUntil: null,
        exhaustedReason: null,
        lastSignalAt: now,
        lastSignalSource: 'schedule',
      });
      await this.recoverSubscription(subscription, 'наступил декларированный сброс окна');
      reset += 1;
    }
    return reset;
  }

  /** Polls every provider that can reach its numbers itself. Claude cannot (token lives on the worker). */
  private static async runRefreshCycle(): Promise<void> {
    if (listHarnessLimitProviders().every((provider) => !provider.refresh)) return;
    const bindings = await AgentWorkerHarness.findAll();
    for (const binding of bindings) {
      const provider = harnessLimitProviderFor(binding.harnessKey);
      if (!provider?.refresh) continue;
      try {
        const worker = await AgentWorker.findByPk(binding.workerId);
        if (!worker) continue;
        const subscription = binding.subscriptionId ? await AgentHarnessSubscription.findByPk(binding.subscriptionId) : null;
        const snapshot = await provider.refresh(this.providerContext(worker, subscription));
        if (!snapshot) continue;
        await this.applySnapshot({
          workerId: worker.id,
          harnessKey: binding.harnessKey,
          snapshot,
          source: 'refresh',
        });
      } catch (error) {
        console.warn(`[AgentizCapacity] refresh failed for ${binding.workerId}/${binding.harnessKey}:`,
          error instanceof Error ? error.message : error);
      }
    }
  }

  private static async sweepSampleRetention(): Promise<void> {
    const cutoff = new Date(Date.now() - Math.max(SAMPLE_RETENTION_DAYS, 1) * 24 * 60 * 60_000);
    await AgentHarnessUsageSample.destroy({ where: { observedAt: { [Op.lt]: cutoff } } });
  }
}
