import { AgentProject } from '../models/AgentProject';

/**
 * Formatting an instant for human eyes, in a person's own timezone.
 *
 * Every stored timestamp is UTC and every wire timestamp is ISO-8601 — this module is only about
 * the moment a `Date` becomes *text* a person reads: dashboard-bell messages, run-log lines, push
 * bodies. The timezone comes from Adminizer's user model (`UserAP.timezone`, an IANA name set in
 * the profile); when there is no addressed user — a broadcast notification, a run log read by
 * everyone — `AGENTIZ_DEFAULT_TIMEZONE` decides, falling back to the server's own zone.
 */

/** An IANA name is only usable if this runtime's ICU data knows it. */
export function isValidTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== 'string' || !timezone.trim()) return false;
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function defaultTimezone(): string {
  const configured = process.env.AGENTIZ_DEFAULT_TIMEZONE;
  if (isValidTimezone(configured)) return configured;
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * `18.08.2026, 21:05` in the given zone — seconds dropped on purpose, these strings name deadlines
 * ("закрыта до …"), not events. An unusable timezone falls back to the default silently: this runs
 * inside notification paths that must not fail over a typo in a profile field.
 */
export function formatUserTime(date: Date, timezone?: string | null): string {
  const timeZone = isValidTimezone(timezone) ? timezone : defaultTimezone();
  return date.toLocaleString('ru-RU', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** `2 ч 15 мин` until `until`, `45 мин` under an hour; null once the moment has passed. */
export function formatRemaining(until: Date, now: Date = new Date()): string | null {
  const minutes = Math.ceil((until.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return null;
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} ч ${minutes % 60} мин` : `${minutes} мин`;
}

/**
 * `18.08.2026, 21:05 (осталось 2 ч 15 мин)` — how a deadline reads in a message: the absolute
 * moment in the reader's zone plus how far away it is, which no timezone can garble.
 */
export function formatUserDeadline(until: Date, timezone?: string | null): string {
  const remaining = formatRemaining(until);
  return remaining ? `${formatUserTime(until, timezone)} (осталось ${remaining})` : formatUserTime(until, timezone);
}

/** The zone's offset from UTC at `date`, in minutes — what a client without tz data can apply. */
export function timezoneOffsetMinutes(timezone: string, date: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  }).formatToParts(date);
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

/**
 * The timezone stored on an Adminizer user, by id. Resolved through the shared Sequelize registry
 * the same way MobileAuthService reaches `UserAP`; anything missing — no id, no model, no row, no
 * usable value — answers `null` and the caller formats in the default zone.
 */
export async function userTimezoneById(userId: number | string | null | undefined): Promise<string | null> {
  if (userId === null || userId === undefined || userId === '') return null;
  try {
    const sequelize = AgentProject.sequelize;
    if (!sequelize?.isDefined('UserAP')) return null;
    const user = await sequelize.model('UserAP').findByPk(userId as any, { attributes: ['id', 'timezone'] });
    const timezone = (user as any)?.get?.('timezone');
    return isValidTimezone(timezone) ? timezone : null;
  } catch {
    return null;
  }
}
