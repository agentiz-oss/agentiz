/**
 * Working-hours windows: when a job (or a whole worker machine) is allowed to work.
 *
 * The representation is shared by `spec.constraints.activeHours` (copied to
 * `AgentRunJob.scheduleWindow` at queue time) and `AgentWorker.activeHours`. All boundary
 * arithmetic happens in the declared IANA zone on each concrete date — so DST is handled by
 * definition — and comparisons happen in UTC. `end < start` is legal and means a window across
 * midnight (a night shift).
 */

export type ActiveDay = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface ActiveHoursWindow {
  days: ActiveDay[];
  /** "HH:MM", local to the schedule's timezone. */
  start: string;
  /** "HH:MM". Less than `start` means the window runs into the next day. */
  end: string;
}

export interface ActiveHoursSchedule {
  /** IANA zone, e.g. "Europe/Belgrade". Required — a window without a zone is a guess. */
  timezone: string;
  windows: ActiveHoursWindow[];
  /** Only `start-only` is enforced today: an open window is required to start, not to finish. */
  enforcement?: 'start-only' | 'pause';
}

const DAY_KEYS: ActiveDay[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/** Throws when the zone is unknown to this runtime — used by validation, no extra dependency. */
export function assertValidTimezone(timezone: string): void {
  new Intl.DateTimeFormat('en-US', { timeZone: timezone });
}

export function isValidTimezone(timezone: string): boolean {
  try {
    assertValidTimezone(timezone);
    return true;
  } catch {
    return false;
  }
}

export function parseHhMm(text: string): number | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text ?? '');
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

interface ZoneParts {
  year: number;
  month: number;
  day: number;
  /** 0 = Sunday, matching DAY_KEYS. */
  weekday: number;
  minutesOfDay: number;
}

function zoneParts(instant: Date, timeZone: string): ZoneParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) parts[part.type] = part.value;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday ?? '');
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: weekday >= 0 ? weekday : 0,
    // "24" appears for midnight in some ICU versions despite hour12: false.
    minutesOfDay: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
}

/**
 * The UTC instant of "that local wall-clock time in that zone", with the standard two-pass offset
 * correction so a DST transition on the target day still resolves to the right instant.
 */
function zonedTimeToUtc(year: number, month: number, day: number, minutesOfDay: number, timeZone: string): Date {
  const naive = Date.UTC(year, month - 1, day, Math.floor(minutesOfDay / 60), minutesOfDay % 60);
  let guess = naive;
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = zoneParts(new Date(guess), timeZone);
    const seenNaive = Date.UTC(seen.year, seen.month - 1, seen.day,
      Math.floor(seen.minutesOfDay / 60), seen.minutesOfDay % 60);
    guess += naive - seenNaive;
  }
  return new Date(guess);
}

function normalizedWindows(schedule: ActiveHoursSchedule): ActiveHoursWindow[] {
  return (schedule.windows ?? []).filter((window) =>
    Array.isArray(window.days) && window.days.length > 0
    && parseHhMm(window.start) !== null && parseHhMm(window.end) !== null);
}

/** Whether `now` falls inside any declared window. An empty/invalid schedule counts as open. */
export function isScheduleOpen(schedule: ActiveHoursSchedule | null | undefined, now: Date = new Date()): boolean {
  if (!schedule?.timezone || !isValidTimezone(schedule.timezone)) return true;
  const windows = normalizedWindows(schedule);
  if (windows.length === 0) return true;
  const local = zoneParts(now, schedule.timezone);
  const today = DAY_KEYS[local.weekday];
  const yesterday = DAY_KEYS[(local.weekday + 6) % 7];
  for (const window of windows) {
    const start = parseHhMm(window.start)!;
    const end = parseHhMm(window.end)!;
    if (start === end) continue;
    if (start < end) {
      if (window.days.includes(today) && local.minutesOfDay >= start && local.minutesOfDay < end) return true;
    } else {
      // Overnight: today's evening part, or the tail of a window that started yesterday.
      if (window.days.includes(today) && local.minutesOfDay >= start) return true;
      if (window.days.includes(yesterday) && local.minutesOfDay < end) return true;
    }
  }
  return false;
}

/**
 * The next occurrence of "that local wall-clock time in that zone" strictly after `now`, today or
 * within the next days. Limit providers use it to turn "resets 3am" (a time in the worker
 * machine's zone) into an instant. Null on invalid input.
 */
export function nextDailyMoment(minutesOfDay: number, timezone: string, now: Date = new Date()): Date | null {
  if (!Number.isFinite(minutesOfDay) || minutesOfDay < 0 || minutesOfDay >= 24 * 60 || !isValidTimezone(timezone)) return null;
  let best: number | null = null;
  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const local = zoneParts(new Date(now.getTime() + dayOffset * MS_PER_DAY), timezone);
    const candidate = zonedTimeToUtc(local.year, local.month, local.day, minutesOfDay, timezone).getTime();
    if (candidate > now.getTime() && (best === null || candidate < best)) best = candidate;
  }
  return best === null ? null : new Date(best);
}

/**
 * The next occurrence of "that weekday at that local time in that zone" strictly after `now`.
 * Used by subscription reset schedules ({ kind: 'weekly' }). Null on invalid input.
 */
export function nextWeeklyMoment(day: ActiveDay, time: string, timezone: string, now: Date = new Date()): Date | null {
  return weeklyMoment(day, time, timezone, now, 'next');
}

/** The latest occurrence at or before `now`. Null on invalid input. */
export function prevWeeklyMoment(day: ActiveDay, time: string, timezone: string, now: Date = new Date()): Date | null {
  return weeklyMoment(day, time, timezone, now, 'prev');
}

function weeklyMoment(day: ActiveDay, time: string, timezone: string, now: Date, mode: 'next' | 'prev'): Date | null {
  const minutes = parseHhMm(time);
  if (minutes === null || !DAY_KEYS.includes(day) || !isValidTimezone(timezone)) return null;
  let best: number | null = null;
  for (let dayOffset = -8; dayOffset <= 8; dayOffset += 1) {
    const local = zoneParts(new Date(now.getTime() + dayOffset * MS_PER_DAY), timezone);
    if (DAY_KEYS[local.weekday] !== day) continue;
    const candidate = zonedTimeToUtc(local.year, local.month, local.day, minutes, timezone).getTime();
    if (mode === 'next' && candidate > now.getTime() && (best === null || candidate < best)) best = candidate;
    if (mode === 'prev' && candidate <= now.getTime() && (best === null || candidate > best)) best = candidate;
  }
  return best === null ? null : new Date(best);
}

/**
 * The earliest instant at or after `now` when the schedule is open. `now` itself when it already
 * is. Returns `now` for an empty/invalid schedule too — a broken window must never park a job
 * forever, that is what validation is for.
 */
export function nextScheduleOpen(schedule: ActiveHoursSchedule | null | undefined, now: Date = new Date()): Date {
  if (isScheduleOpen(schedule, now)) return now;
  const windows = normalizedWindows(schedule!);
  let best: number | null = null;
  // Every window recurs at least weekly, so the coming 8 local days cover every next opening.
  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const local = zoneParts(new Date(now.getTime() + dayOffset * MS_PER_DAY), schedule!.timezone);
    for (const window of windows) {
      if (!window.days.includes(DAY_KEYS[local.weekday])) continue;
      const start = parseHhMm(window.start)!;
      const candidate = zonedTimeToUtc(local.year, local.month, local.day, start, schedule!.timezone).getTime();
      if (candidate > now.getTime() && (best === null || candidate < best)) best = candidate;
    }
  }
  return best === null ? now : new Date(best);
}
