/**
 * The small formatting and address helpers every ported screen needs.
 *
 * They live here rather than in each screen for the reason the whole rework exists: three copies
 * of «сколько ждёт» drift into three different answers to the same question. Nothing here knows
 * about a particular entity — anything that does belongs next to the screen that draws it.
 */

/**
 * Russian plural: `plural(2, 'запуск', 'запуска', 'запусков')`. A number beside the wrong verb or
 * noun reads as a bug in the number, which is the one thing a status screen must not do.
 */
export function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** How long ago, coarsely: `12 мин` / `5 ч` / `3 дн`. Empty for a missing instant. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ч`;
  return `${Math.round(hours / 24)} дн`;
}

/**
 * How long something took, or has been taking when `to` is absent: `45 с` / `12 мин` /
 * `1 ч 05 мин`. A run row is read at a glance, and «идёт 4 мин» answers the question an absolute
 * timestamp only lets the reader compute.
 */
export function elapsed(from: string | null | undefined, to?: string | null): string {
  if (!from) return '';
  const start = new Date(from).getTime();
  const end = to ? new Date(to).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ч ${String(minutes % 60).padStart(2, '0')} мин`;
}

/**
 * A tab or a filter, written into the address without asking the server for anything.
 *
 * `replaceState`, never an Inertia visit: the sidebar, the crumbs and the help button are
 * per-request page props, so a *screen* change has to reach the server — but a tab does not choose
 * a screen, and reloading the page to switch one would throw away the log the reader is watching.
 */
export function setQueryParam(name: string, value: string | null): void {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  window.history.replaceState({}, '', url.toString());
}

export function queryParam(name: string): string | null {
  return new URL(window.location.href).searchParams.get(name);
}

/** A run id is a uuid; a person reads and quotes its head. Never used to address anything. */
export function shortId(id: string | null | undefined): string {
  return (id ?? '').slice(0, 8);
}
