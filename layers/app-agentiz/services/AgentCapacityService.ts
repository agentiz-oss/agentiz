import { Op } from 'sequelize';
import { AgentHarnessSubscription } from '../models/AgentHarnessSubscription';
import { AgentHarnessUsageSample } from '../models/AgentHarnessUsageSample';
import { AgentRun } from '../models/AgentRun';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentWorker } from '../models/AgentWorker';
import { AgentWorkerHarness } from '../models/AgentWorkerHarness';
import { harnessLimitProviderFor, listHarnessLimitProviders } from '../lib/harnessLimits';
import type { HarnessLimitProviderContext, HarnessLimitSignal, HarnessLimitSnapshot } from '../lib/harnessLimits';
import { isScheduleOpen, nextScheduleOpen, nextWeeklyMoment, prevWeeklyMoment } from '../lib/activeHours';
import { alignState } from '../lib/harnessAlign';
import { MIXED_HARNESS_KEY } from '../lib/harness';
import { harnessTitle } from '../lib/harnessCatalog';
import { sendDashboardNotification } from '../lib/notifications/dashboardNotifications';
import { formatUserDeadline } from '../lib/userTime';
import { ActivityService } from './ActivityService';
import { AgentPipelineService } from './AgentPipelineService';
import type { HarnessAuthState, HarnessPokeResult, HarnessSignalSource, HarnessWindowState } from '../types/agentiz';

/** How often the capacity sweep runs (schedule windows, declared resets). */
/** A poke error is a diagnosis, not a log: one line is enough and the column is not a sink. */
const POKE_ERROR_MAX_LENGTH = 300;
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

/** An auth detail is one diagnostic line for a person, not a place to keep a stack trace. */
const AUTH_DETAIL_MAX_LENGTH = 300;
/** How many parked jobs one sweep looks at — the same order of magnitude as the other sweeps. */
const AUTH_SWEEP_JOB_LIMIT = 200;

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

/**
 * How far two reports may put the same reset moment apart and still mean the same window.
 *
 * A provider is not obliged to hand back a stable instant: Claude recomputes `resets_at` per
 * request, so the same 07:00 window arrives as `06:59:59.654Z` and `07:00:00.164Z` two minutes
 * apart — jitter that straddles a second *and* a minute boundary, which is why neither exact
 * comparison nor truncation works. Reset moments a person is shown are minute-grained and a real
 * one moves by a whole window, so anything under a minute is noise.
 */
const RESET_JITTER_TOLERANCE_MS = 60_000;

/** Same reset moment as far as a reader is concerned — see `RESET_JITTER_TOLERANCE_MS`. */
function sameResetMoment(before: string | null, after: string | null): boolean {
  if (before === after) return true;
  if (!before || !after) return false;
  const previous = new Date(before).getTime();
  const next = new Date(after).getTime();
  if (!Number.isFinite(previous) || !Number.isFinite(next)) return before === after;
  return Math.abs(next - previous) <= RESET_JITTER_TOLERANCE_MS;
}

/**
 * A telemetry heartbeat is not usage.  Labels, observation time and report source explain the
 * reading but do not consume a subscription, so the idle clock advances through identical
 * reports and resets only when a window's actual quota state changes.
 */
function limitWindowsChanged(before: HarnessWindowState[], after: HarnessWindowState[]): boolean {
  const state = (windows: HarnessWindowState[]) => new Map(windows.map((window) => [window.key, {
    usedPercent: window.usedPercent ?? null,
    resetsAt: window.resetsAt ?? null,
  }]));
  const previous = state(before);
  const next = state(after);
  if (previous.size !== next.size) return true;
  for (const [key, current] of next) {
    const old = previous.get(key);
    if (!old || old.usedPercent !== current.usedPercent) return true;
    if (!sameResetMoment(old.resetsAt, current.resetsAt)) return true;
  }
  return false;
}

type DisplayHints = Pick<HarnessWindowState, 'meter' | 'sessionWindowMinutes'>;

/**
 * The two display hints a provider may attach to a window, copied only when it actually set one.
 * Spelling the keys out as `undefined` instead would put them into every stored sample and change
 * the shape of a window written before the fields existed.
 */
function displayHints(window: { meter?: unknown; sessionWindowMinutes?: unknown }): DisplayHints {
  const hints: DisplayHints = {};
  if (window.meter === 'used' || window.meter === 'remaining') hints.meter = window.meter;
  if (typeof window.sessionWindowMinutes === 'number' && Number.isFinite(window.sessionWindowMinutes)
    && window.sessionWindowMinutes > 0) {
    hints.sessionWindowMinutes = window.sessionWindowMinutes;
  }
  return hints;
}

export interface LimitSignalOutcome {
  subscription: AgentHarnessSubscription;
  binding: AgentWorkerHarness;
  exhaustedUntil: Date;
}

export interface AuthStateOutcome {
  /** Null only when an `ok` statement arrived for a harness this worker has no binding for. */
  binding: AgentWorkerHarness | null;
  /** Whether the state actually flipped — the only case that notifies or wakes anything. */
  changed: boolean;
}

export interface AppliedSnapshotOutcome {
  subscription: AgentHarnessSubscription | null;
  /**
   * Null for a report that carried no telemetry at all — the credential-only report a worker
   * sends when it cannot read the numbers *because* it is logged out. Storing an empty-window
   * sample every two minutes for such a machine would be history nobody can read.
   */
  sample: AgentHarnessUsageSample | null;
  warnings: string[];
  /** Present when the report also said something about the machine's authorization. */
  auth?: AuthStateOutcome;
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
   * Harness keys this worker must not receive right now: bindings switched off by an operator,
   * bindings whose machine cannot log in, and bindings whose subscription is exhausted (including
   * preventively). Read by the claim gate on every claim, hence the small cache.
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
      // Nobody is logged in on this machine, so every stage of that harness would fail on its
      // first call. Unlike a limit this is *not* a subscription's state — the credential sits in
      // this worker's home directory, and a sibling worker on the same account keeps working.
      // Also unlike a limit it has no end time, which is why nothing here touches `availableAt`:
      // the gate opens the moment the worker reports a live credential again.
      if (binding.needsLogin()) {
        keys.push(binding.harnessKey);
        continue;
      }
      if (!binding.subscriptionId) continue;
      const subscription = await AgentHarnessSubscription.findByPk(binding.subscriptionId);
      if (subscription?.isExhausted(now)) {
        keys.push(binding.harnessKey);
        continue;
      }
      // Reset alignment: while the next window must not open yet (see lib/harnessAlign.ts),
      // the subscription is paused exactly like an operator-disabled binding — a claim-side
      // gate that touches no job's availableAt and lifts by itself at A−W. With `keepWindowsOpen`
      // the band is the exact (A−2W, A−W) instead of the tolerated one; without alignment it is
      // empty, because a chain with no anchor never has a reason to wait.
      if (subscription
        && alignState(subscription.alignConfig(), subscription.windows, now, subscription.keepWindowsOpen) === 'hold') {
        keys.push(binding.harnessKey);
      }
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
      message: `Подписка «${subscription.name}» закрыта до ${formatUserDeadline(exhaustedUntil)}`,
      metadata: { subscriptionId: subscription.id, workerId: params.worker.id, harnessKey: params.harnessKey },
    });
    return { subscription, binding, exhaustedUntil };
  }

  /**
   * The single write point for "can this machine log in to this harness" — see
   * `HarnessAuthState` for why that lives on the binding and not on the subscription.
   *
   * Two sources reach it and they answer the same question at different moments: the worker's
   * usage reporter, which holds the credential and can therefore say so **before** any run, and a
   * stage failure a provider classified as `auth`. Both are idempotent — only a flip does
   * anything, so a machine repeating "still logged out" every two minutes writes one notification
   * and one streak start, not one per report.
   *
   * The recovery direction is deliberately generous: any statement of `ok` re-opens the gate at
   * once, because the cheapest proof that the credential works is the worker having just used it.
   */
  static async applyAuthState(params: {
    worker: Pick<AgentWorker, 'id' | 'name'>;
    harnessKey: string;
    state: HarnessAuthState;
    /** One line for a person: what the worker or the failed stage actually said. */
    detail?: string | null;
    source: HarnessSignalSource;
    observedAt?: Date;
  }): Promise<AuthStateOutcome> {
    const now = params.observedAt ?? new Date();
    const detail = params.detail ? params.detail.trim().slice(0, AUTH_DETAIL_MAX_LENGTH) : null;

    if (params.state === 'ok') {
      // Never materialises a binding: "this machine is fine" about a harness nobody declared here
      // is not news, and auto-creating a row (and an implicit subscription with it) for it would
      // fill the directory with machines that merely have a CLI installed.
      const binding = await AgentWorkerHarness.findOne({
        where: { workerId: params.worker.id, harnessKey: params.harnessKey },
      });
      if (!binding) return { binding: null, changed: false };
      const wasExpired = binding.authState === 'expired';
      await binding.update({ authState: 'ok', authDetail: null, authCheckedAt: now, authFailedSince: null });
      if (!wasExpired) return { binding, changed: false };
      const woken = await this.recoverAuth(params.worker, now);
      void sendDashboardNotification({
        channel: 'harness-auth',
        title: `Вход в ${harnessTitle(params.harnessKey)} на воркере ${params.worker.name} восстановлен`,
        message: woken > 0 ? `Продолжаем ${woken} задач(и)` : 'Очередь этого harness\'а снова раздаётся',
        metadata: { workerId: params.worker.id, harnessKey: params.harnessKey, wokenJobs: woken },
      });
      return { binding, changed: true };
    }

    // A machine that says "I am logged out" *does* run this harness — it just cannot authenticate
    // — so the binding is materialised exactly as a limit signal materialises one.
    const { binding } = await this.ensureBinding(params.worker, params.harnessKey);
    const wasExpired = binding.authState === 'expired';
    await binding.update({
      authState: 'expired',
      authDetail: detail,
      authCheckedAt: now,
      // The streak's start survives every repeat, so a reader learns "не работает с 12.09 20:46"
      // instead of the moment of the latest of two hundred identical reports.
      authFailedSince: wasExpired ? binding.authFailedSince ?? now : now,
    });
    if (wasExpired) return { binding, changed: false };
    this.invalidateGateCache();
    void sendDashboardNotification({
      channel: 'harness-auth',
      title: `Нужен вход: ${harnessTitle(params.harnessKey)} на воркере ${params.worker.name}`,
      message: `Авторизация закончилась${detail ? ` (${detail})` : ''}. Войдите заново в браузере на машине воркера`
        + ' — задачи этого harness\'а ждут в очереди и продолжатся сами.',
      metadata: { workerId: params.worker.id, harnessKey: params.harnessKey, source: params.source },
    });
    return { binding, changed: true };
  }

  /**
   * Wakes what the closed auth gate was holding. Pinned jobs only, exactly like
   * `recoverSubscription`: an unpinned one sits on a short backoff and any worker that can log in
   * may already have taken it.
   */
  private static async recoverAuth(worker: Pick<AgentWorker, 'id'>, now: Date): Promise<number> {
    this.invalidateGateCache();
    const [woken] = await AgentRunJob.update({ availableAt: now }, {
      where: {
        status: { [Op.in]: ['released', 'queued'] },
        deferReason: 'harness_auth',
        requiredWorkerId: worker.id,
        availableAt: { [Op.gt]: now },
      },
    });
    return woken;
  }

  /**
   * The one place a *report* becomes a snapshot: either an already normalized `snapshot`, or a
   * provider-specific `raw` payload run through that harness's `interpretReport`.
   *
   * Both transports of external telemetry go through here — the worker's usage reporter
   * (`POST /harness-usage`) and `agentiz.reportHarnessUsage` — so a provider whose report shape
   * changes is fixed in the provider layer alone, and neither caller learns a field name.
   */
  static async applyReport(params: {
    workerId?: string | null;
    subscriptionId?: string | null;
    harnessKey: string;
    raw?: unknown;
    snapshot?: { windows?: unknown[]; meta?: unknown; accountId?: string };
    observedAt?: Date;
    /** What came of the window poke this worker was last asked for; see normalizePoke. */
    poke?: unknown;
    /** Whether the machine can authenticate at all; see normalizeAuth. */
    auth?: unknown;
  }): Promise<AppliedSnapshotOutcome> {
    const auth = this.normalizeAuth(params.auth);
    // A report with no telemetry is legal exactly when it carries a credential verdict: that is
    // the shape a logged-out machine can still send, and refusing it would leave the one state a
    // person has to act on as the only state nobody can report.
    const hasTelemetry = (params.raw !== undefined && params.raw !== null)
      || Array.isArray(params.snapshot?.windows);
    if (!hasTelemetry) {
      if (!auth || !params.workerId) {
        throw new Error('Either raw (with a provider registered) or snapshot.windows is required');
      }
      const worker = await AgentWorker.findByPk(params.workerId);
      if (!worker) throw new Error(`AgentWorker ${params.workerId} not found`);
      const outcome = await this.applyAuthState({
        worker,
        harnessKey: params.harnessKey,
        state: auth.state,
        detail: auth.detail,
        source: 'report',
        observedAt: params.observedAt,
      });
      const subscription = outcome.binding?.subscriptionId
        ? await AgentHarnessSubscription.findByPk(outcome.binding.subscriptionId)
        : null;
      return { subscription, sample: null, warnings: [], auth: outcome };
    }
    let snapshot = params.snapshot;
    if (!snapshot && params.raw !== undefined && params.raw !== null) {
      const provider = harnessLimitProviderFor(params.harnessKey);
      if (!provider?.interpretReport) {
        throw new Error(`No registered provider can interpret raw reports for "${params.harnessKey}" — send a normalized snapshot instead`);
      }
      const worker = params.workerId ? await AgentWorker.findByPk(params.workerId) : null;
      const interpreted = provider.interpretReport(params.raw, this.providerContext(
        worker ?? { id: '', name: '', hostname: null, timezone: null, capabilities: null },
        null,
      ));
      if (!interpreted) throw new Error(`Provider "${provider.id}" could not interpret the raw report`);
      snapshot = interpreted as typeof snapshot;
    }
    if (!snapshot || !Array.isArray(snapshot.windows)) {
      throw new Error('Either raw (with a provider registered) or snapshot.windows is required');
    }
    return this.applySnapshot({
      workerId: params.workerId,
      subscriptionId: params.subscriptionId,
      harnessKey: params.harnessKey,
      snapshot: {
        windows: (snapshot.windows as HarnessWindowState[]).map((window) => ({
          key: String(window.key),
          label: typeof window.label === 'string' ? window.label : String(window.key),
          usedPercent: typeof window.usedPercent === 'number' ? window.usedPercent : undefined,
          resetsAt: window.resetsAt ? new Date(window.resetsAt) : null,
          ...displayHints(window),
        })),
        meta: snapshot.meta,
        accountId: typeof snapshot.accountId === 'string' ? snapshot.accountId : undefined,
      },
      source: 'report',
      observedAt: params.observedAt,
      poke: this.normalizePoke(params.poke),
      auth,
    });
  }

  /**
   * Reads a worker's verdict on its own credential. Shaped defensively for the same reason
   * `normalizePoke` is: it arrives from a machine that may be older than the field, and anything
   * unrecognizable must read as "said nothing" rather than as a logout.
   *
   * Only the two states the core acts on are accepted. A worker that finds no credential store at
   * all reports nothing — a machine that simply does not run this harness is not logged out of it.
   */
  private static normalizeAuth(value: unknown): { state: HarnessAuthState; detail: string | null } | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const payload = value as Record<string, unknown>;
    if (payload.state !== 'ok' && payload.state !== 'expired') return undefined;
    const detail = typeof payload.detail === 'string' ? payload.detail.trim().slice(0, AUTH_DETAIL_MAX_LENGTH) : null;
    return { state: payload.state, detail: detail || null };
  }

  /**
   * Reads a worker's report of the window poke it was asked for. Shaped defensively because it
   * arrives from a machine that may be older than this field: anything unrecognizable is simply
   * not a report, and the subscription keeps whatever it knew.
   */
  private static normalizePoke(value: unknown): { at: string; ok: boolean; error?: string | null } | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const payload = value as Record<string, unknown>;
    if (typeof payload.ok !== 'boolean') return undefined;
    const at = typeof payload.at === 'string' ? new Date(payload.at) : new Date();
    const error = typeof payload.error === 'string' ? payload.error.trim().slice(0, POKE_ERROR_MAX_LENGTH) : null;
    return {
      at: (Number.isNaN(at.getTime()) ? new Date() : at).toISOString(),
      ok: payload.ok,
      error: error || null,
    };
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
    poke?: { at: string; ok: boolean; error?: string | null };
    auth?: { state: HarnessAuthState; detail: string | null };
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
      ...displayHints(window),
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
      const mergedWindows = [...merged.values()];
      const updates: Partial<{
        windows: HarnessWindowState[];
        accountId: string | null;
        lastSignalAt: Date;
        lastSignalSource: HarnessSignalSource;
        lastLimitChangeAt: Date;
        lastPoke: HarnessPokeResult | null;
      }> = {
        windows: mergedWindows,
        lastSignalAt: now,
        lastSignalSource: params.source,
      };
      if (limitWindowsChanged(subscription.windows ?? [], mergedWindows)) {
        updates.lastLimitChangeAt = observedAt;
      }
      if (params.poke) {
        const previous = subscription.lastPoke;
        updates.lastPoke = {
          at: params.poke.at,
          ok: params.poke.ok,
          error: params.poke.ok ? null : params.poke.error ?? null,
          workerId,
          // The streak's start survives every repeat, so a reader learns "broken since 04:01"
          // rather than only the latest of twenty-nine identical failures.
          failedSince: params.poke.ok
            ? null
            : (previous && !previous.ok && previous.failedSince ? previous.failedSince : params.poke.at),
        };
      }
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

    // Numbers that arrived from a machine *are* the proof that its credential works: Claude's
    // usage endpoint is behind the very OAuth token a stage would use, and Codex's is behind its
    // CLI's own login. So a report with windows clears the state even from a worker too old to
    // send the field — without this, one classified `auth` failure would gate such a machine
    // forever, since nothing else would ever say otherwise.
    const authState = params.auth?.state ?? (params.source === 'report' && windows.length > 0 ? 'ok' : null);
    let auth: AuthStateOutcome | undefined;
    if (authState && workerId) {
      const worker = await AgentWorker.findByPk(workerId);
      if (worker) {
        auth = await this.applyAuthState({
          worker,
          harnessKey: params.harnessKey,
          state: authState,
          detail: params.auth?.detail ?? null,
          source: params.source,
          observedAt,
        });
      }
    }

    return { subscription, sample, warnings, auth };
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
      await this.sweepAuthBlockedRuns();
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
        // A machine that cannot log in has no ETA at all, so the moment is left alone and only
        // the reason is added: an invented time here would be shown as a promise.
        if (binding?.needsLogin()) reasons.push(`harness_auth:${key}`);
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
          message: `${worstReason}, до ${formatUserDeadline(worstUntil)}`,
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
   * Says out loud what the auth gate is holding — the half of this feature that answers "я
   * запустил задачу, и в приложении просто ничего не появилось".
   *
   * The gate itself is silent by construction: a gated key simply does not match the claim query,
   * so a job whose only harness is logged out sits `queued` with an `availableAt` in the past and
   * nothing anywhere says why. This sweep turns that silence into the two things a person can
   * see — `run.waitingReason` and one `harness.auth_required` activity (hence a push) per parked
   * run — and it does so **once**: the second pass finds `waitingReason` already set and says
   * nothing more.
   *
   * Which jobs count as held is deliberately narrow, because "nobody can run this" is a claim
   * about the whole fleet: a job pinned to a logged-out machine is stuck whatever else exists,
   * while an unpinned one is stuck only when no worker can log in to that harness at all.
   */
  private static async sweepAuthBlockedRuns(): Promise<number> {
    const expired = await AgentWorkerHarness.findAll({ where: { authState: 'expired' } });
    // The common case, and the one every installation that never saw this feature is in.
    if (expired.length === 0) return 0;

    const keys = [...new Set(expired.map((binding) => binding.harnessKey))];
    const siblings = await AgentWorkerHarness.findAll({ where: { harnessKey: { [Op.in]: keys } } });
    const workers = await AgentWorker.findAll({
      where: { id: { [Op.in]: [...new Set(siblings.map((binding) => binding.workerId))] } },
    });
    const workerById = new Map(workers.map((worker) => [worker.id, worker]));
    const hasHealthyWorker = new Set(keys.filter((key) => siblings.some((binding) => binding.harnessKey === key
      && binding.enabled
      && binding.authState !== 'expired'
      && workerById.get(binding.workerId)?.status === 'active')));

    const jobs = await AgentRunJob.findAll({
      where: {
        status: { [Op.in]: ['queued', 'released'] },
        harnessKey: { [Op.in]: [...keys, MIXED_HARNESS_KEY] },
      },
      order: [['createdAt', 'ASC']],
      limit: AUTH_SWEEP_JOB_LIMIT,
    });

    let parked = 0;
    for (const job of jobs) {
      const blocking = this.jobHarnessKeys(job).find((key) => {
        if (!keys.includes(key)) return false;
        if (job.requiredWorkerId) {
          return expired.some((binding) => binding.workerId === job.requiredWorkerId && binding.harnessKey === key);
        }
        return !hasHealthyWorker.has(key);
      });
      if (!blocking) continue;

      const run = await AgentRun.findByPk(job.runId);
      if (!run || ['succeeded', 'failed', 'cancelled'].includes(run.status)) continue;
      if (run.waitingReason === 'harness_auth') continue;

      const binding = expired.find((item) => item.harnessKey === blocking
        && (!job.requiredWorkerId || item.workerId === job.requiredWorkerId)) ?? null;
      await job.update({ deferReason: 'harness_auth' });
      const noted = await this.noteAuthBlockedRun({
        run,
        jobId: job.id,
        harnessKey: blocking,
        workerId: binding?.workerId ?? null,
        workerName: binding ? workerById.get(binding.workerId)?.name ?? binding.workerId : null,
        detail: binding?.authDetail ?? null,
        since: binding?.authFailedSince ?? null,
      });
      if (noted) parked += 1;
    }
    return parked;
  }

  /**
   * Says, once, that one run is parked because a machine has to be logged into again — the run's
   * own waiting badge, a line in its log and one `harness.auth_required` activity (hence a push).
   *
   * Shared by the two paths that discover it: a stage that failed on the credential
   * (`AgentRunDeferService`) and this sweep, which is what finds the runs that never got that far
   * because the claim gate was already closed. The guard is `run.waitingReason`, so whichever of
   * the two gets there first is the one that speaks and the other stays quiet.
   */
  static async noteAuthBlockedRun(params: {
    run: AgentRun;
    jobId?: string | null;
    harnessKey: string;
    workerId: string | null;
    workerName: string | null;
    detail?: string | null;
    since?: Date | null;
  }): Promise<boolean> {
    const { run } = params;
    if (run.waitingReason === 'harness_auth') return false;
    // No `waitingUntil`: this wait has no deadline, and inventing one would put a time in front of
    // a person that nothing is going to honour.
    await run.update({ waitingReason: 'harness_auth', waitingUntil: null });

    const harness = harnessTitle(params.harnessKey);
    const where = params.workerName ? `на воркере ${params.workerName}` : 'на воркере';
    await AgentPipelineService.log(run.id, run.projectId, null, 'warn',
      `Запуск ждёт: ${where} закончилась авторизация ${harness} — нужно войти заново через браузер`,
      { jobId: params.jobId ?? null, harnessKey: params.harnessKey, workerId: params.workerId, detail: params.detail ?? null });
    await ActivityService.record({
      type: 'harness.auth_required',
      projectId: run.projectId,
      runId: run.id,
      taskId: run.taskId,
      title: `Нужен вход в ${harness} ${where}`,
      body: `Задача стоит и ждёт: авторизация ${harness} на машине воркера закончилась, и сервер не может продлить её сам.`
        + ' Откройте на этой машине браузер и войдите в аккаунт заново — запуск продолжится сам, перезапускать ничего не нужно.'
        + (params.detail ? ` Воркер сообщил: ${params.detail}` : ''),
      data: {
        harnessKey: params.harnessKey,
        workerId: params.workerId,
        workerName: params.workerName,
        since: params.since ? params.since.toISOString() : null,
      },
    });
    return true;
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
