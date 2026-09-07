import { describe, expect, it } from 'vitest';
import { classifyCodexFailure, interpretCodexReport } from './codexLimitProvider';
import type { HarnessLimitProviderContext } from '../../app-agentiz/lib/harnessLimits';

const context: HarnessLimitProviderContext = {
  worker: { id: 'w1', name: 'worker-1', hostname: 'host', timezone: 'Asia/Ho_Chi_Minh' },
  subscription: { id: 's1', authKind: 'subscription' },
};

describe('interpretCodexReport', () => {
  it('reads a legacy primary/secondary snapshot and keeps the raw payload', () => {
    const raw = {
      accountId: 'acct_123', planType: 'pro', credits: { hasCredits: false },
      rateLimits: {
        primary: { usedPercent: 64, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 7, resetsAt: 1_800_604_800 },
        windowDurationMins: 10_080,
      },
    };
    const report = interpretCodexReport(raw, context)!;
    expect(report.accountId).toBe('acct_123');
    expect(report.windows.map((window) => window.key)).toEqual(['codex:primary', 'codex:secondary']);
    expect(report.windows[0].label).toBe('Codex · основное (7 дн.)');
    expect(report.windows[0].resetsAt?.toISOString()).toBe('2027-01-15T08:00:00.000Z');
    expect(report.meta).toBe(raw);
  });

  it('uses each populated limit-id bucket independently', () => {
    const report = interpretCodexReport({
      rateLimits: {},
      rateLimitsByLimitId: {
        'gpt-5.6': { limitName: 'GPT-5.6', primary: { usedPercent: 42, resetsAt: 1_800_000_000 } },
        weekly: { limitId: 'weekly-all', primary: { usedPercent: 4 }, secondary: { usedPercent: 2 } },
      },
    }, context)!;
    expect(report.windows.map((window) => window.key)).toEqual(['gpt-5.6:primary', 'weekly-all:primary', 'weekly-all:secondary']);
    expect(report.windows[1].resetsAt).toBeNull();
  });

  it('states Codex quota as what is left, without inventing a session window', () => {
    const report = interpretCodexReport({
      rateLimits: { primary: { usedPercent: 64, resetsAt: 1_800_000_000 }, windowDurationMins: 10_080 },
    }, context)!;
    // The stored number stays "used" — stopPolicy thresholds compare against it — and only the
    // reading is inverted, which is what the panel and the app render as «осталось 36%».
    expect(report.windows[0].usedPercent).toBe(64);
    expect(report.windows[0].meter).toBe('remaining');
    // A Codex plan has no 5-hour session, so nothing may print «ещё N полных окон» for it.
    expect(report.windows[0].sessionWindowMinutes).toBeUndefined();
  });

  it('rejects malformed, empty and API-key-shaped reports', () => {
    expect(interpretCodexReport(null, context)).toBeNull();
    expect(interpretCodexReport({ rateLimits: {} }, context)).toBeNull();
    expect(interpretCodexReport({ rateLimits: { primary: { remainingRequests: 10 } } }, context)).toBeNull();
  });
});

describe('classifyCodexFailure', () => {
  it.each([
    ['usage_limit_exceeded', 'exhausted'],
    ["You've hit your usage limit", 'exhausted'],
    ['workspace_daily_usage_limit_reached', 'exhausted'],
    ['credits_depleted', 'exhausted'],
    ['rate_limit_exceeded (429)', 'throttled'],
  ] as const)('classifies %s', (text, kind) => {
    expect(classifyCodexFailure(text, context)?.kind).toBe(kind);
  });

  it('does not mistake a context window for an account limit', () => {
    expect(classifyCodexFailure('context_window_exceeded', context)).toBeNull();
  });
});
