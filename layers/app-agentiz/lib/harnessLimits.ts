/**
 * The seam between the capacity core and provider-specific knowledge about harness limits.
 *
 * The core (app-agentiz) knows no error formats, no usage endpoints and no window model of any
 * concrete provider. All of that lives in a `HarnessLimitProvider` an external layer contributes
 * through the `harnessLimitProviders` collection (see HarnessLimitProviderCollection.ts). The core
 * speaks one abstract language — "window X is N% used, resets at T" — and builds gates and
 * scheduling on it. With an empty collection everything still works, just in manual mode:
 * `markHarnessExhausted`, `resetSchedule`, concurrency and activeHours need no classification.
 */

/** Abstract limit window: everything the core is allowed to know about a quota. */
export interface HarnessLimitWindow {
  /** Provider's own vocabulary: '5h', 'weekly', 'weekly-opus', … */
  key: string;
  /** UI label. */
  label: string;
  /** How much of the window is used, when known. */
  usedPercent?: number;
  /** When the window resets, when known. */
  resetsAt?: Date | null;
}

/** One classified failure: "this is a limit, here is when to resume". */
export interface HarnessLimitSignal {
  kind: 'exhausted' | 'throttled';
  windowKey?: string;
  /** null ⇒ the core applies its backoff ladder / the subscription's resetSchedule. */
  resumeAt?: Date | null;
  /** Which pattern matched — goes to the log and to exhaustedReason. */
  matched: string;
}

/** Telemetry snapshot: abstract windows plus opaque provider detail. */
export interface HarnessLimitSnapshot {
  windows: HarnessLimitWindow[];
  /**
   * Metadata OUTSIDE the abstract contract: Claude has its own fields (5h session start,
   * per-model split, plan), Codex its own. The core never interprets it — only stores it in
   * samples and returns it to UI/MCP as-is. The provider layer owns the shape and any
   * conclusions drawn from it.
   */
  meta?: unknown;
  /** Account identity — for subscription auto-binding and cross-worker mismatch detection. */
  accountId?: string;
}

export interface HarnessLimitProviderContext {
  worker: { id: string; name: string; hostname: string | null; timezone: string | null };
  subscription: { id: string; authKind: string | null } | null;
}

export interface HarnessLimitProvider {
  /** Stable id for logs and replacement on layer re-mount. */
  id: string;
  /** Which harnessKey values this provider serves ('claude' — keys from lib/harness.ts). */
  handles(harnessKey: string): boolean;
  /** Window dictionary — the core builds state structure and UI from it. */
  declareWindows(): Array<Pick<HarnessLimitWindow, 'key' | 'label'>>;
  /** Stage failure → limit signal, or null ("not mine, let it fail normally"). */
  classifyFailure(errorText: string, ctx: HarnessLimitProviderContext): HarnessLimitSignal | null;
  /** Raw usage report delivered from outside (MCP / a script on the worker machine) → snapshot. */
  interpretReport?(raw: unknown, ctx: HarnessLimitProviderContext): HarnessLimitSnapshot | null;
  /** Active polling, when the provider can reach the numbers itself (optional, phase 4). */
  refresh?(ctx: HarnessLimitProviderContext): Promise<HarnessLimitSnapshot | null>;
}

// Shared mutable state hangs off a global symbol: under tsx this module can be instantiated twice
// (ESM + CJS graphs) and a plain module-level Map would silently split in two.
const PROVIDERS_KEY = Symbol.for('agentiz.harnessLimitProviders');

function registry(): Map<string, HarnessLimitProvider> {
  const holder = globalThis as unknown as Record<symbol, Map<string, HarnessLimitProvider>>;
  if (!holder[PROVIDERS_KEY]) holder[PROVIDERS_KEY] = new Map();
  return holder[PROVIDERS_KEY];
}

export function registerHarnessLimitProvider(provider: HarnessLimitProvider): void {
  registry().set(provider.id, provider);
}

export function unregisterHarnessLimitProvider(id: string): void {
  registry().delete(id);
}

export function listHarnessLimitProviders(): HarnessLimitProvider[] {
  return [...registry().values()];
}

/**
 * The provider serving one harness key. One key — at most one provider: the first registered one
 * wins, a second claiming the same key is reported once by the collection handler.
 */
export function harnessLimitProviderFor(harnessKey: string): HarnessLimitProvider | null {
  for (const provider of registry().values()) {
    try {
      if (provider.handles(harnessKey)) return provider;
    } catch (error) {
      // A broken provider must read as "no provider", never break the caller.
      console.warn(`[app-agentiz] harness limit provider "${provider.id}" failed in handles():`,
        error instanceof Error ? error.message : error);
    }
  }
  return null;
}

/**
 * Classification wrapped so a throwing provider equals "not classified": the failed-result path
 * this is called from must terminalize the job whatever the provider does.
 */
export function classifyHarnessFailure(
  harnessKey: string,
  errorText: string,
  ctx: HarnessLimitProviderContext,
): HarnessLimitSignal | null {
  const provider = harnessLimitProviderFor(harnessKey);
  if (!provider) return null;
  try {
    return provider.classifyFailure(errorText, ctx);
  } catch (error) {
    console.warn(`[app-agentiz] harness limit provider "${provider.id}" failed in classifyFailure():`,
      error instanceof Error ? error.message : error);
    return null;
  }
}
