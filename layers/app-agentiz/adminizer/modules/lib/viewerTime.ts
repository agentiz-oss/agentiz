import { useEffect, useState } from "react";
import axios from "axios";

/**
 * Timestamps a person reads on the dashboard, in *their* timezone.
 *
 * The zone comes from the profile (`UserAP.timezone`) via `/dashboard/agentiz-viewer`, not from
 * the browser: the machine's zone is wherever the machine is. It is fetched once per page and
 * shared between every module bundle through a `window`-scoped promise — the modules are separate
 * Vite bundles, so plain module state would fetch once per bundle instead.
 *
 * `formatDateTime` is deliberately usable before the fetch resolves (it falls back to the
 * browser's zone); `useViewerTimezone` is what makes a component re-render once the real zone
 * arrives.
 */

const PREFIX = (window as any).routePrefix ?? "/dashboard";
const CACHE_KEY = "__agentizViewerTimezone";

function timezonePromise(): Promise<string | null> {
  const w = window as any;
  if (!w[CACHE_KEY]) {
    w[CACHE_KEY] = axios
      .get(`${PREFIX}/agentiz-viewer`)
      .then((res): string | null => (typeof res.data?.data?.timezone === "string" ? res.data.data.timezone : null))
      .catch((): string | null => null);
  }
  return w[CACHE_KEY];
}

export function useViewerTimezone(): string | null {
  const [timezone, setTimezone] = useState<string | null>((window as any)[`${CACHE_KEY}Value`] ?? null);
  useEffect(() => {
    let alive = true;
    timezonePromise().then((tz) => {
      (window as any)[`${CACHE_KEY}Value`] = tz;
      if (alive) setTimezone(tz);
    });
    return () => {
      alive = false;
    };
  }, []);
  return timezone;
}

/** `2 ч 15 мин` until the given instant, `45 мин` under an hour; null once it has passed. */
export function formatRemaining(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const until = new Date(iso).getTime();
  if (Number.isNaN(until)) return null;
  const minutes = Math.ceil((until - Date.now()) / 60_000);
  if (minutes <= 0) return null;
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} ч ${minutes % 60} мин` : `${minutes} мин`;
}

/** ` (осталось …)` when the moment is still ahead, empty once it is not. */
export function remainingSuffix(iso: string | null | undefined): string {
  const remaining = formatRemaining(iso);
  return remaining ? ` (осталось ${remaining})` : "";
}

/**
 * `18.08.2026, 21:05` in the viewer's zone; an unparseable input comes back unchanged. The
 * timezone argument is optional so plain helper functions can call this without threading it —
 * omitted means "whatever the shared fetch has answered by now", and the root component's
 * `useViewerTimezone()` call is what re-renders everything once that answer lands.
 */
export function formatDateTime(iso: string | null | undefined, timezone?: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const zone = timezone ?? (window as any)[`${CACHE_KEY}Value`] ?? null;
  try {
    return date.toLocaleString("ru-RU", {
      timeZone: zone ?? undefined,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    // An IANA name this browser does not know: better the machine's zone than a crash.
    return date.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
}
