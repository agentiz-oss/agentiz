import type {
  HarnessLimitProvider,
  HarnessLimitProviderContext,
  HarnessLimitSignal,
  HarnessLimitSnapshot,
  HarnessLimitWindow,
} from '../../app-agentiz/lib/harnessLimits';

type ObjectRecord = Record<string, unknown>;

function object(value: unknown): value is ObjectRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function durationLabel(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  if (value % (60 * 24) === 0) return `${value / (60 * 24)} дн.`;
  if (value % 60 === 0) return `${value / 60} ч.`;
  return `${value} мин.`;
}

function resetDate(value: unknown): Date | null {
  // app-server documents Unix *seconds*. Accepting arbitrary milliseconds or a wildly distant
  // number would turn malformed telemetry into a gate held for centuries.
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 946684800 || value > 4102444800) return null;
  return new Date(value * 1000);
}

function windowLabel(snapshot: ObjectRecord, role: 'primary' | 'secondary'): string {
  const name = typeof snapshot.limitName === 'string' && snapshot.limitName.trim()
    ? ` · ${snapshot.limitName.trim()}`
    : '';
  const roleName = role === 'primary' ? 'основное' : 'дополнительное';
  const duration = durationLabel(snapshot.windowDurationMins);
  return `Codex${name} · ${roleName}${duration ? ` (${duration})` : ''}`;
}

function readSnapshot(snapshot: ObjectRecord, fallbackKey: string): HarnessLimitWindow[] {
  const limitId = typeof snapshot.limitId === 'string' && snapshot.limitId.trim()
    ? snapshot.limitId.trim()
    : fallbackKey;
  const windows: HarnessLimitWindow[] = [];
  for (const role of ['primary', 'secondary'] as const) {
    const entry = snapshot[role];
    if (!object(entry) || typeof entry.usedPercent !== 'number' || !Number.isFinite(entry.usedPercent)) continue;
    windows.push({
      key: `${limitId}:${role}`,
      label: windowLabel(snapshot, role),
      usedPercent: entry.usedPercent,
      resetsAt: resetDate(entry.resetsAt),
      // Codex's own console states what is left, not what is spent, and the number a person
      // compares against it must say the same thing. The stored value stays "used": only the
      // reading is inverted, so stop policy thresholds keep meaning what they meant.
      meter: 'remaining',
      // Deliberately no sessionWindowMinutes: a Codex plan has no session window, so its buckets
      // are readable only as a reset moment plus the hours and minutes left until it.
    });
  }
  return windows;
}

/**
 * Converts the intentionally opaque `account/rateLimits/read` result into capacity-core windows.
 * Buckets stay provider-defined: neither their number nor a model-to-bucket association is a
 * business rule in Agentiz.
 */
export function interpretCodexReport(raw: unknown, _ctx: HarnessLimitProviderContext): HarnessLimitSnapshot | null {
  if (!object(raw) || !object(raw.rateLimits)) return null;
  const byLimitId = object(raw.rateLimitsByLimitId) && Object.keys(raw.rateLimitsByLimitId).length > 0
    ? raw.rateLimitsByLimitId
    : null;
  const windows = byLimitId
    ? Object.entries(byLimitId).flatMap(([key, snapshot]) => object(snapshot) ? readSnapshot(snapshot, key) : [])
    : readSnapshot(raw.rateLimits, 'codex');
  if (windows.length === 0) return null;
  return {
    windows,
    // Store the full app-server result, including future fields, but let only this layer interpret it.
    meta: raw,
    accountId: typeof raw.accountId === 'string' ? raw.accountId : undefined,
  };
}

export function classifyCodexFailure(errorText: string, _ctx: HarnessLimitProviderContext): HarnessLimitSignal | null {
  const text = errorText.trim();
  if (!text) return null;
  if (/credits_depleted/i.test(text)) {
    return { kind: 'exhausted', resumeAt: null, matched: 'codex-credits-depleted' };
  }
  if (/usage_limit_exceeded|usage limit reached|you'?ve hit your usage limit|workspace_[\w-]*_usage_limit_reached/i.test(text)) {
    return { kind: 'exhausted', resumeAt: null, matched: 'codex-usage-limit' };
  }
  if (/rate_limit_exceeded|\b429\b|rate limit exceeded/i.test(text)) {
    // null deliberately selects the core's existing short throttling backoff; Codex text has no
    // stable reset timestamp contract to parse here.
    return { kind: 'throttled', resumeAt: null, matched: 'codex-rate-limit' };
  }
  return null;
}

export const codexLimitProvider: HarnessLimitProvider = {
  id: 'app-agentiz-codex-limits:codex',
  handles: (harnessKey) => harnessKey === 'codex',
  // app-server's bucket set is dynamic, so windows can be declared only after telemetry arrives.
  declareWindows: () => [],
  classifyFailure: (errorText, ctx) => classifyCodexFailure(errorText, ctx),
  interpretReport: (raw, ctx) => interpretCodexReport(raw, ctx),
};
