import { isValidTimezone, nextDailyMoment } from './activeHours';
import type { HarnessWindowState } from '../types/agentiz';

/**
 * Aligning a subscription's session-window reset to a daily hour ("токены обнуляются в 9:00").
 *
 * A provider resets a session window a fixed time after it *opens*, so the only lever is the
 * moment the first request opens a new window. Everything here is best-effort by design: it
 * reads the same advisory `subscription.windows` telemetry the UI shows, never touches
 * `exhaustedUntil`, and when telemetry is missing or stale it simply does nothing.
 *
 * The reset is aimed at the anchor ± a tolerance: exactness costs pause time (the pause exists
 * because 24h does not divide evenly by W), and the operator accepted "between 8 and 10" in
 * exchange for a 3-hour pause ceiling instead of a 5-hour one. When the queue is idle the poke
 * still fires at exactly A−W, so an idle night ends in a reset at the anchor to the minute.
 *
 * Relative to the next anchor A (the configured hour in the configured zone), with W = the
 * session window length and T = the tolerance, and only when no session window is currently open:
 *  - `hold`  — now ∈ (A−2W+T, A−W−T): opening a window now would make its reset land where the
 *    window after it could no longer reset within A±T. The claim gate pauses new work; the first
 *    claim after the hold opens a window whose reset lands inside the band by itself.
 *  - `poke`  — now ∈ [A−W, A): the aligned window should be open but is not (the queue was
 *    empty). The worker is asked to open it with a minimal request.
 *  - `none`  — everywhere else — including [A−W−T, A−W), the early edge of the band, where a
 *    claim is welcome to open a slightly-early window but an idle machine keeps waiting for the
 *    exact moment — and always while a window is open or telemetry is silent.
 *
 * `keepWindowsOpen` (the `chain` argument) replaces those three bands with one rule and one
 * exception: no window open means open one, unless it would close later than A−W — the moment an
 * aligned window has to start. The tolerance is what a mechanism pays for not choosing the moment
 * itself; when it does choose, the hold band is exactly (A−2W, A−W) and the poke lands on A−W to
 * the minute. Whatever closed a window in that band — the flag switched on mid-day, a person
 * working under the same account, a worker that was offline — runs into the hold and the chain is
 * back on the anchor within a day, with no catch-up code. Without an anchor (alignment off or its
 * config broken) the flag simply always opens: it does not depend on alignment.
 */

/** Length of the session window this feature aligns. Claude's 5h; good enough for all of today's providers. */
export const SESSION_WINDOW_MS = 5 * 60 * 60_000;

/** How far a reset may land from the anchor. Buys the pause ceiling down from W to W−2T. */
export const ALIGN_TOLERANCE_MS = 60 * 60_000;

/** Telemetry older than this says nothing about the present — stale data must not pause work. */
const TELEMETRY_FRESH_MS = 15 * 60_000;

export interface AlignConfig {
  /** Local hour (0–23) the reset should land on. */
  hour: number;
  /** IANA timezone the hour is expressed in. */
  timezone: string;
}

export type AlignState = 'none' | 'hold' | 'poke';

/**
 * Whether a session window is open right now, judged from cached telemetry.
 * `true` — open; `false` — fresh telemetry and none open; `null` — no fresh telemetry, unknown.
 * "Session window" is recognized structurally (a reset within the next W), not by provider key.
 */
export function sessionWindowOpen(windows: HarnessWindowState[] | null | undefined, now: Date): boolean | null {
  let fresh = false;
  for (const window of windows ?? []) {
    const observedAt = window.observedAt ? Date.parse(window.observedAt) : NaN;
    if (!Number.isFinite(observedAt) || now.getTime() - observedAt > TELEMETRY_FRESH_MS) continue;
    fresh = true;
    const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
    if (!Number.isFinite(resetsAt)) continue;
    if (resetsAt > now.getTime() && resetsAt - now.getTime() <= SESSION_WINDOW_MS) return true;
  }
  return fresh ? false : null;
}

/** The next moment the reset should land on, or null when the alignment config says nothing. */
function nextAnchor(config: AlignConfig | null, now: Date): Date | null {
  if (!config) return null;
  if (!Number.isInteger(config.hour) || config.hour < 0 || config.hour > 23) return null;
  if (!config.timezone || !isValidTimezone(config.timezone)) return null;
  return nextDailyMoment(config.hour * 60, config.timezone, now);
}

export function alignState(
  config: AlignConfig | null,
  windows: HarnessWindowState[] | null | undefined,
  now: Date = new Date(),
  chain = false,
): AlignState {
  // An open window is never gated (work inside it does not move the reset), and unknown state
  // must not pause anything — best-effort means erring toward doing nothing. First in both modes:
  // the chain flag opens windows, never opens one blind.
  if (sessionWindowOpen(windows, now) !== false) return 'none';
  const anchor = nextAnchor(config, now);
  if (chain) {
    if (!anchor) return 'poke';
    const untilAnchor = anchor.getTime() - now.getTime();
    // The one exception: a window opened here closes after A−W, so the aligned one could not
    // start on time. Waiting out that band is what makes the chain land on the anchor itself.
    return untilAnchor > SESSION_WINDOW_MS && untilAnchor < 2 * SESSION_WINDOW_MS ? 'hold' : 'poke';
  }
  if (!anchor) return 'none';
  const untilAnchor = anchor.getTime() - now.getTime();
  if (untilAnchor <= SESSION_WINDOW_MS) return 'poke';
  if (untilAnchor <= SESSION_WINDOW_MS + ALIGN_TOLERANCE_MS) return 'none';
  if (untilAnchor < 2 * SESSION_WINDOW_MS - ALIGN_TOLERANCE_MS) return 'hold';
  return 'none';
}
