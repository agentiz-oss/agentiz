import type {
  HarnessLimitProvider,
  HarnessLimitProviderContext,
  HarnessLimitSignal,
  HarnessLimitSnapshot,
  HarnessLimitWindow,
} from '../../app-agentiz/lib/harnessLimits';
import { nextDailyMoment } from '../../app-agentiz/lib/activeHours';

/**
 * Everything Claude-specific about usage limits lives here, behind the abstract
 * `HarnessLimitProvider` contract: refusal wordings, the OAuth usage endpoint's field names, and
 * the model of three subscription windows. The core sees only `{key, usedPercent, resetsAt}`.
 *
 * The three windows of a Claude subscription:
 *  - `5h` — the session window: starts with the first message, shared by every CLI instance under
 *    one account. Short deferrals; the refusal text almost always names the reset time.
 *  - `weekly` — resets every 7 days at a per-account moment (visible in /usage). This is the
 *    "task legally waits a week" scenario; put the moment into the subscription's resetSchedule
 *    and the gate opens by itself even when a refusal names no time.
 *  - `weekly-opus` — the separate Opus window. On Max plans Claude Code silently degrades
 *    Opus → Sonnet as it approaches, so a hard refusal is rare: this window is caught by
 *    telemetry and closed, if at all, by stopPolicy.
 *
 * `authKind: 'api-key'` is a different regime — RPM/TPM, `rate_limit_error` (429, minutes) and
 * `overloaded_error` (529), no weekly windows — recognized by its own patterns below.
 */

const WINDOWS: Array<Pick<HarnessLimitWindow, 'key' | 'label'>> = [
  { key: '5h', label: '5-часовая сессия' },
  { key: 'weekly', label: 'Недельное окно' },
  { key: 'weekly-opus', label: 'Недельное окно Opus' },
];

/** Maps the OAuth usage endpoint's window names to our abstract keys. */
const REPORT_WINDOW_KEYS: Record<string, string> = {
  five_hour: '5h',
  '5h': '5h',
  session: '5h',
  seven_day: 'weekly',
  weekly: 'weekly',
  seven_day_opus: 'weekly-opus',
  seven_day_oauth_apps: 'weekly-oauth-apps',
  'weekly-opus': 'weekly-opus',
};

function minutesFromClockText(hourText: string, minuteText: string | undefined, meridiem: string | undefined): number | null {
  let hour = Number(hourText);
  const minute = Number(minuteText ?? '0');
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) return null;
  const suffix = meridiem?.toLowerCase();
  if (suffix === 'pm' && hour < 12) hour += 12;
  if (suffix === 'am' && hour === 12) hour = 0;
  if (hour > 23) return null;
  return hour * 60 + minute;
}

/**
 * "resets 3am" / "resets 21:30" out of a refusal, resolved in the worker machine's zone — the
 * text was rendered there. No zone known ⇒ null: the core falls back to resetSchedule/backoff,
 * which beats guessing a server-zone 3am that may be hours off.
 */
function parseResetClock(text: string, ctx: HarnessLimitProviderContext, now: Date): Date | null {
  const match = /reset(?:s|s at|ting at)?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
  if (!match) return null;
  if (!match[2] && !match[3]) return null; // a bare number ("resets 7") is too ambiguous to trust
  const minutes = minutesFromClockText(match[1], match[2], match[3]);
  const timezone = ctx.worker.timezone;
  if (minutes === null || !timezone) return null;
  return nextDailyMoment(minutes, timezone, now);
}

function windowKeyFromText(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (/(5|five)[\s-]?hour/.test(lower) || lower.includes('session limit')) return '5h';
  if (lower.includes('opus')) return 'weekly-opus';
  if (lower.includes('weekly') || lower.includes('7-day') || lower.includes('seven day')) return 'weekly';
  return undefined;
}

export function classifyClaudeFailure(errorText: string, ctx: HarnessLimitProviderContext, now: Date = new Date()): HarnessLimitSignal | null {
  const text = errorText.trim();
  if (!text) return null;

  // Historical headless format: the resume moment arrives as a ready unix epoch after "|".
  const epochMatch = /Claude (?:AI )?usage limit reached\|(\d{9,13})/i.exec(text);
  if (epochMatch) {
    const raw = Number(epochMatch[1]);
    const resumeAt = new Date(raw < 1e12 ? raw * 1000 : raw);
    return {
      kind: 'exhausted',
      windowKey: windowKeyFromText(text) ?? '5h',
      resumeAt,
      matched: 'claude-usage-limit-epoch',
    };
  }

  // API-key regime: rate limiting and overload are minutes, not windows.
  if (/rate_limit_error|number of requests has exceeded your rate limit|429 .*rate limit/i.test(text)) {
    return { kind: 'throttled', resumeAt: new Date(now.getTime() + 2 * 60_000), matched: 'anthropic-rate-limit' };
  }
  if (/overloaded_error|status 529|overloaded/i.test(text) && /anthropic|claude|api/i.test(text)) {
    return { kind: 'throttled', resumeAt: new Date(now.getTime() + 5 * 60_000), matched: 'anthropic-overloaded' };
  }

  // TUI wordings of the subscription windows: "5-hour limit reached ∙ resets 3am",
  // "Weekly limit reached ∙ resets Oct 14", "You've reached your usage limit", …
  if (/(usage|5-hour|five hour|weekly|session) limit (?:reached|hit)|you'?ve reached your .*limit|usage limit reached/i.test(text)) {
    return {
      kind: 'exhausted',
      windowKey: windowKeyFromText(text) ?? (/(usage limit)/i.test(text) ? '5h' : undefined),
      resumeAt: parseResetClock(text, ctx, now),
      matched: 'claude-limit-text',
    };
  }

  return null;
}

export function interpretClaudeReport(raw: unknown, _ctx: HarnessLimitProviderContext): HarnessLimitSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const windows: HarnessLimitWindow[] = [];
  const meta: Record<string, unknown> = {};

  for (const [rawKey, value] of Object.entries(source)) {
    const key = REPORT_WINDOW_KEYS[rawKey];
    if (!key || !value || typeof value !== 'object') {
      // Everything outside the window contract stays opaque provider detail.
      if (rawKey !== 'accountId') meta[rawKey] = value;
      continue;
    }
    const window = value as Record<string, unknown>;
    const used = window.utilization ?? window.usedPercent ?? window.used_percent;
    const resets = window.resets_at ?? window.resetsAt;
    windows.push({
      key,
      label: WINDOWS.find((declared) => declared.key === key)?.label ?? key,
      usedPercent: typeof used === 'number' ? used : undefined,
      resetsAt: typeof resets === 'string' || typeof resets === 'number' ? new Date(resets) : null,
    });
    meta[rawKey] = value;
  }
  if (windows.length === 0) return null;

  const account = source.accountId
    ?? (source.account as Record<string, unknown> | undefined)?.email
    ?? (source.oauthAccount as Record<string, unknown> | undefined)?.emailAddress;
  return {
    windows,
    meta,
    accountId: typeof account === 'string' ? account : undefined,
  };
}

export const claudeLimitProvider: HarnessLimitProvider = {
  id: 'app-agentiz-claude-limits:claude',
  handles: (harnessKey) => harnessKey === 'claude',
  declareWindows: () => WINDOWS,
  classifyFailure: (errorText, ctx) => classifyClaudeFailure(errorText, ctx),
  interpretReport: (raw, ctx) => interpretClaudeReport(raw, ctx),
  // No refresh(): the OAuth usage token lives on the worker machine, so the server cannot pull.
  // Telemetry arrives through agentiz.reportHarnessUsage from a script beside that token.
};
