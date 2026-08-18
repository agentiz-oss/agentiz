import { describe, expect, it } from 'vitest';
import {
  isScheduleOpen,
  nextDailyMoment,
  nextScheduleOpen,
  nextWeeklyMoment,
  prevWeeklyMoment,
} from './activeHours';
import type { ActiveHoursSchedule } from './activeHours';

// 2026-08-17 is a Monday. 12:00Z = 14:00 in Europe/Belgrade (CEST, UTC+2).
const MONDAY_NOON_UTC = new Date('2026-08-17T12:00:00Z');

const workdays: ActiveHoursSchedule = {
  timezone: 'Europe/Belgrade',
  windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '18:00' }],
};

const nightShift: ActiveHoursSchedule = {
  timezone: 'Europe/Belgrade',
  windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '22:00', end: '06:00' }],
};

describe('isScheduleOpen', () => {
  it('is open inside a weekday window and closed outside it', () => {
    expect(isScheduleOpen(workdays, MONDAY_NOON_UTC)).toBe(true);
    expect(isScheduleOpen(workdays, new Date('2026-08-17T17:00:00Z'))).toBe(false); // 19:00 local
    expect(isScheduleOpen(workdays, new Date('2026-08-22T12:00:00Z'))).toBe(false); // Saturday
  });

  it('treats end < start as a window across midnight', () => {
    // Tuesday 02:00 local belongs to Monday's night shift.
    expect(isScheduleOpen(nightShift, new Date('2026-08-18T00:00:00Z'))).toBe(true);
    // Monday 23:00 local is the evening part of the same window.
    expect(isScheduleOpen(nightShift, new Date('2026-08-17T21:00:00Z'))).toBe(true);
    // Monday 14:00 local is neither.
    expect(isScheduleOpen(nightShift, MONDAY_NOON_UTC)).toBe(false);
    // Saturday 02:00 local: Friday's shift tail, still open.
    expect(isScheduleOpen(nightShift, new Date('2026-08-22T00:00:00Z'))).toBe(true);
    // Sunday 02:00 local: Saturday has no shift.
    expect(isScheduleOpen(nightShift, new Date('2026-08-23T00:00:00Z'))).toBe(false);
  });

  it('counts an empty or zone-less schedule as always open — a broken window must not park a job', () => {
    expect(isScheduleOpen(null, MONDAY_NOON_UTC)).toBe(true);
    expect(isScheduleOpen({ timezone: 'Not/AZone', windows: [] } as ActiveHoursSchedule, MONDAY_NOON_UTC)).toBe(true);
  });
});

describe('nextScheduleOpen', () => {
  it('returns now when already open', () => {
    expect(nextScheduleOpen(workdays, MONDAY_NOON_UTC)).toEqual(MONDAY_NOON_UTC);
  });

  it('finds this evening for a night shift', () => {
    // Monday 14:00 local → Monday 22:00 local = 20:00Z.
    expect(nextScheduleOpen(nightShift, MONDAY_NOON_UTC).toISOString()).toBe('2026-08-17T20:00:00.000Z');
  });

  it('skips the weekend', () => {
    // Saturday noon → Monday 09:00 local = 07:00Z.
    const saturday = new Date('2026-08-22T12:00:00Z');
    expect(nextScheduleOpen(workdays, saturday).toISOString()).toBe('2026-08-24T07:00:00.000Z');
  });
});

describe('weekly moments', () => {
  it('computes the next and previous weekly reset in the declared zone', () => {
    // Monday 14:00 local, reset mondays 03:00 local: next is in a week, previous was this morning.
    const next = nextWeeklyMoment('mon', '03:00', 'Europe/Belgrade', MONDAY_NOON_UTC)!;
    const prev = prevWeeklyMoment('mon', '03:00', 'Europe/Belgrade', MONDAY_NOON_UTC)!;
    expect(next.toISOString()).toBe('2026-08-24T01:00:00.000Z');
    expect(prev.toISOString()).toBe('2026-08-17T01:00:00.000Z');
  });

  it('answers null instead of guessing on a bad zone', () => {
    expect(nextWeeklyMoment('mon', '03:00', 'Not/AZone', MONDAY_NOON_UTC)).toBeNull();
  });
});

describe('nextDailyMoment', () => {
  it('resolves "3am worker-local" to the coming night', () => {
    // Monday 14:00 local → Tuesday 03:00 local = Tuesday 01:00Z.
    const at = nextDailyMoment(3 * 60, 'Europe/Belgrade', MONDAY_NOON_UTC)!;
    expect(at.toISOString()).toBe('2026-08-18T01:00:00.000Z');
  });
});
