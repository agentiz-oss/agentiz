import { describe, expect, it } from 'vitest';
import { alignState, sessionWindowOpen, SESSION_WINDOW_MS } from './harnessAlign';
import type { HarnessWindowState } from '../types/agentiz';

const HOUR_MS = 60 * 60_000;

/** 2026-01-15 is deep winter — Europe/Belgrade is UTC+1, no DST edge in these fixtures. */
function utc(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 0, 15, hour, minute));
}

function window(overrides: Partial<HarnessWindowState>, now: Date): HarnessWindowState {
  return { key: '5h', observedAt: now.toISOString(), ...overrides };
}

// Anchor 09:00 Belgrade = 08:00 UTC. With W = 5h and tolerance T = 1h: aligned window start
// 03:00 UTC, hold zone (23:00, 02:00), free early band [02:00, 03:00), poke [03:00, 08:00).
const CONFIG = { hour: 9, timezone: 'Europe/Belgrade' };

describe('sessionWindowOpen', () => {
  it('sees an open window in a reset within the window length', () => {
    const now = utc(0);
    const windows = [window({ resetsAt: new Date(now.getTime() + 2 * HOUR_MS).toISOString() }, now)];
    expect(sessionWindowOpen(windows, now)).toBe(true);
  });

  it('a reset further out than the window length is not a session window', () => {
    const now = utc(0);
    const windows = [window({ key: 'weekly', resetsAt: new Date(now.getTime() + 3 * 24 * HOUR_MS).toISOString() }, now)];
    expect(sessionWindowOpen(windows, now)).toBe(false);
  });

  it('answers unknown, not closed, on stale or missing telemetry', () => {
    const now = utc(0);
    expect(sessionWindowOpen(null, now)).toBeNull();
    expect(sessionWindowOpen([], now)).toBeNull();
    const stale = [window({
      observedAt: new Date(now.getTime() - HOUR_MS).toISOString(),
      resetsAt: new Date(now.getTime() + 2 * HOUR_MS).toISOString(),
    }, now)];
    expect(sessionWindowOpen(stale, now)).toBeNull();
  });
});

describe('alignState', () => {
  const closed = (now: Date) => [window({ resetsAt: new Date(now.getTime() - HOUR_MS).toISOString() }, now)];

  it('holds inside (A−2W+T, A−W−T): a window opened here could not chain into a reset within A±T', () => {
    expect(alignState(CONFIG, closed(utc(23, 30)), utc(23, 30))).toBe('hold');
    expect(alignState(CONFIG, closed(utc(1, 59)), utc(1, 59))).toBe('hold');
  });

  it('frees the early band [A−W−T, A−W): a claim here resets within tolerance', () => {
    expect(alignState(CONFIG, closed(utc(2)), utc(2))).toBe('none');
    expect(alignState(CONFIG, closed(utc(2, 30)), utc(2, 30))).toBe('none');
  });

  it('pokes inside [A−W, A): the aligned window should be open by now', () => {
    expect(alignState(CONFIG, closed(utc(3)), utc(3))).toBe('poke');
    expect(alignState(CONFIG, closed(utc(7, 30)), utc(7, 30))).toBe('poke');
  });

  it('does nothing when a chained window still lands within tolerance', () => {
    expect(alignState(CONFIG, closed(utc(21)), utc(21))).toBe('none');
    // The 23:00 boundary itself chains to a reset exactly at A+T — still inside the band.
    expect(alignState(CONFIG, closed(utc(23)), utc(23))).toBe('none');
    // Right after the anchor the next one is ~24h away.
    expect(alignState(CONFIG, closed(utc(8, 30)), utc(8, 30))).toBe('none');
  });

  it('never gates while a window is open or telemetry is unknown', () => {
    const now = utc(23, 30);
    const open = [window({ resetsAt: new Date(now.getTime() + 2 * HOUR_MS).toISOString() }, now)];
    expect(alignState(CONFIG, open, now)).toBe('none');
    expect(alignState(CONFIG, null, now)).toBe('none');
  });

  it('rejects a broken config instead of guessing', () => {
    // 23:30 would be 'hold' with a valid config, so 'none' here proves the config was rejected.
    const now = utc(23, 30);
    expect(alignState(null, closed(now), now)).toBe('none');
    expect(alignState({ hour: 24, timezone: 'Europe/Belgrade' }, closed(now), now)).toBe('none');
    expect(alignState({ hour: 9, timezone: 'No/Such_Zone' }, closed(now), now)).toBe('none');
  });

  it('window length constant matches the zone math these tests assume', () => {
    expect(SESSION_WINDOW_MS).toBe(5 * HOUR_MS);
  });
});

/**
 * `keepWindowsOpen`: open a window whenever none is open, with one exception — a window that
 * would close later than A−W, the moment the aligned one has to start. Because the mechanism now
 * picks the moment itself, the tolerance is not spent: the hold band is the exact (A−2W, A−W).
 * Anchor 09:00 Belgrade = 08:00 UTC, so hold is (22:00, 03:00) UTC and the poke resumes at 03:00.
 */
describe('alignState with keepWindowsOpen', () => {
  const closed = (now: Date) => [window({ resetsAt: new Date(now.getTime() - HOUR_MS).toISOString() }, now)];
  const chained = (now: Date) => alignState(CONFIG, closed(now), now, true);

  it('holds strictly inside (A−2W, A−W) and opens on both boundaries', () => {
    // d = W exactly: this window closes precisely at the anchor, so it is the aligned one.
    expect(chained(utc(3))).toBe('poke');
    // d = 2W exactly: it closes at A−W, handing over to the aligned window on time.
    expect(chained(utc(22))).toBe('poke');
    // A minute inside either boundary and the chain would miss A−W.
    expect(chained(utc(2, 59))).toBe('hold');
    expect(chained(utc(22, 1))).toBe('hold');
  });

  it('opens everywhere outside that band, including right after the anchor', () => {
    expect(chained(utc(8, 30))).toBe('poke');
    expect(chained(utc(12))).toBe('poke');
    expect(chained(utc(21))).toBe('poke');
  });

  it('does not depend on alignment: with no anchor it always opens', () => {
    const now = utc(23, 30);
    expect(alignState(null, closed(now), now, true)).toBe('poke');
    expect(alignState({ hour: 24, timezone: 'Europe/Belgrade' }, closed(now), now, true)).toBe('poke');
    expect(alignState({ hour: 9, timezone: 'No/Such_Zone' }, closed(now), now, true)).toBe('poke');
  });

  it('never opens one blind: an open window or silent telemetry is still nothing', () => {
    const now = utc(12);
    const open = [window({ resetsAt: new Date(now.getTime() + 2 * HOUR_MS).toISOString() }, now)];
    expect(alignState(CONFIG, open, now, true)).toBe('none');
    expect(alignState(CONFIG, null, now, true)).toBe('none');
    expect(alignState(null, null, now, true)).toBe('none');
  });

  it('leaves the flagless answer exactly as it was where the two modes disagree', () => {
    // 22:30 = d 9h30m: outside the tolerated hold band, inside the exact one.
    expect(alignState(CONFIG, closed(utc(22, 30)), utc(22, 30))).toBe('none');
    expect(alignState(CONFIG, closed(utc(22, 30)), utc(22, 30), false)).toBe('none');
    expect(chained(utc(22, 30))).toBe('hold');
    // 02:30 = the free early edge of the tolerance, which the exact band still holds.
    expect(alignState(CONFIG, closed(utc(2, 30)), utc(2, 30))).toBe('none');
    expect(alignState(CONFIG, closed(utc(2, 30)), utc(2, 30), false)).toBe('none');
    expect(chained(utc(2, 30))).toBe('hold');
    // 12:00 = idle mid-day: the old mode waits for A−W, the chain opens now.
    expect(alignState(CONFIG, closed(utc(12)), utc(12))).toBe('none');
    expect(chained(utc(12))).toBe('poke');
  });
});
