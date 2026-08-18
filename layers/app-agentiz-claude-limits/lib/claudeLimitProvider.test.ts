import { describe, expect, it } from 'vitest';
import { classifyClaudeFailure, interpretClaudeReport } from './claudeLimitProvider';
import type { HarnessLimitProviderContext } from '../../app-agentiz/lib/harnessLimits';

const NOW = new Date('2026-08-17T12:00:00Z');

function ctx(timezone: string | null = 'Europe/Belgrade', authKind: string | null = 'subscription'): HarnessLimitProviderContext {
  return {
    worker: { id: 'w1', name: 'worker-1', hostname: 'host', timezone },
    subscription: { id: 's1', authKind },
  };
}

describe('classifyClaudeFailure', () => {
  it('reads the historical headless format with a ready epoch', () => {
    const resetEpoch = Math.floor(new Date('2026-08-17T19:00:00Z').getTime() / 1000);
    const signal = classifyClaudeFailure(`Claude AI usage limit reached|${resetEpoch}`, ctx(), NOW)!;
    expect(signal.kind).toBe('exhausted');
    expect(signal.matched).toBe('claude-usage-limit-epoch');
    expect(signal.resumeAt?.toISOString()).toBe('2026-08-17T19:00:00.000Z');
  });

  it('parses "resets 3am" in the worker machine\'s zone', () => {
    const signal = classifyClaudeFailure('5-hour limit reached ∙ resets 3am', ctx(), NOW)!;
    expect(signal.windowKey).toBe('5h');
    // Next 03:00 Europe/Belgrade after Monday 14:00 local = Tuesday 01:00Z.
    expect(signal.resumeAt?.toISOString()).toBe('2026-08-18T01:00:00.000Z');
  });

  it('degrades to "time unknown" without a worker timezone instead of guessing', () => {
    const signal = classifyClaudeFailure('5-hour limit reached ∙ resets 3am', ctx(null), NOW)!;
    expect(signal.kind).toBe('exhausted');
    expect(signal.resumeAt).toBeNull();
  });

  it('recognizes the weekly window from its wording', () => {
    const signal = classifyClaudeFailure('Weekly limit reached ∙ resets Oct 14', ctx(), NOW)!;
    expect(signal.windowKey).toBe('weekly');
    // A date without a clock is not parsed — the core falls back to resetSchedule/backoff.
    expect(signal.resumeAt).toBeNull();
  });

  it('classifies a timeless refusal with no resume time', () => {
    const signal = classifyClaudeFailure("You've reached your usage limit.", ctx(), NOW)!;
    expect(signal.kind).toBe('exhausted');
    expect(signal.resumeAt).toBeNull();
  });

  it('treats api-key rate limiting as short throttling', () => {
    const signal = classifyClaudeFailure('rate_limit_error: Number of requests has exceeded your rate limit', ctx(null, 'api-key'), NOW)!;
    expect(signal.kind).toBe('throttled');
    expect(signal.resumeAt!.getTime()).toBeGreaterThan(NOW.getTime());
    expect(signal.resumeAt!.getTime()).toBeLessThan(NOW.getTime() + 10 * 60_000);
  });

  it('leaves an ordinary failure alone', () => {
    expect(classifyClaudeFailure('TypeError: Cannot read properties of undefined', ctx(), NOW)).toBeNull();
    expect(classifyClaudeFailure('', ctx(), NOW)).toBeNull();
  });
});

describe('interpretClaudeReport', () => {
  it('maps the OAuth usage shape onto abstract windows and keeps the rest in meta', () => {
    const snapshot = interpretClaudeReport({
      five_hour: { utilization: 68, resets_at: '2026-08-17T19:00:00Z' },
      seven_day: { utilization: 43, resets_at: '2026-08-24T01:00:00Z' },
      seven_day_opus: { utilization: 12 },
      plan: 'max',
      oauthAccount: { emailAddress: 'ivan@example.com' },
    }, ctx())!;
    const byKey = Object.fromEntries(snapshot.windows.map((window) => [window.key, window]));
    expect(byKey['5h'].usedPercent).toBe(68);
    expect(byKey.weekly.resetsAt?.toISOString()).toBe('2026-08-24T01:00:00.000Z');
    expect(byKey['weekly-opus'].usedPercent).toBe(12);
    expect(snapshot.accountId).toBe('ivan@example.com');
    expect((snapshot.meta as Record<string, unknown>).plan).toBe('max');
  });

  it('answers null for a shape it does not know', () => {
    expect(interpretClaudeReport({ nonsense: true }, ctx())).toBeNull();
    expect(interpretClaudeReport('text', ctx())).toBeNull();
  });
});
