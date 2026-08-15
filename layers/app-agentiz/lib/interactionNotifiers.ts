/**
 * Who gets told that an agent has stopped to ask a question.
 *
 * A pending interaction is invisible until somebody looks at it: the run parks in `waiting_input`
 * and stays there until a human answers, so the value of knowing about it is entirely in how fast
 * the news travels. Delivery, though, is not a core concern — push tokens, FCM/APNs credentials and
 * device bookkeeping belong to whichever layer owns those devices (today
 * app-agentiz-mobile-api). So app-agentiz owns the *event* and the extension point, and contributes
 * no notifier of its own.
 *
 * Registration goes through the `interactionNotifiers` app-manager collection — see
 * InteractionNotifierCollection.ts — rather than a direct import, so a layer that is not installed
 * simply means nobody is listening.
 */

/** What happened, in the terms a notifier needs to address the right people. */
export interface InteractionCreatedEvent {
  interactionId: string;
  projectId: string;
  runId: string;
  /** ACP source that asked (`claude`, `codex`, …) — a notifier may want to name it. */
  source: string;
  /** The question itself, as the agent phrased it. */
  message: string;
}

export interface InteractionNotifier {
  /** Stable id of the contributing layer's notifier, used in logs and to replace on re-mount. */
  id: string;
  notifyCreated(event: InteractionCreatedEvent): Promise<void> | void;
}

// Shared mutable state has to hang off a global symbol: under tsx this module can be instantiated
// twice (ESM + CJS graphs) and a plain module-level Map would silently split in two, leaving the
// notifier registered in one copy and the event emitted from the other.
const NOTIFIERS_KEY = Symbol.for('agentiz.interactionNotifiers');

function registry(): Map<string, InteractionNotifier> {
  const holder = globalThis as unknown as Record<symbol, Map<string, InteractionNotifier>>;
  if (!holder[NOTIFIERS_KEY]) holder[NOTIFIERS_KEY] = new Map();
  return holder[NOTIFIERS_KEY];
}

export function registerInteractionNotifier(notifier: InteractionNotifier): void {
  registry().set(notifier.id, notifier);
}

export function unregisterInteractionNotifier(id: string): void {
  registry().delete(id);
}

export function listInteractionNotifiers(): InteractionNotifier[] {
  return [...registry().values()];
}

/**
 * Announces a newly created interaction. Deliberately not awaited by the caller: this runs inside
 * the worker's `requestHumanInput` call, and a slow or unreachable push service must not hold up
 * the agent's own request — worse, must not fail it. Every notifier is isolated, so one throwing
 * still leaves the others delivered.
 */
export function notifyInteractionCreated(event: InteractionCreatedEvent): void {
  for (const notifier of listInteractionNotifiers()) {
    void (async () => {
      try {
        await notifier.notifyCreated(event);
      } catch (error) {
        console.warn(
          `[app-agentiz] interaction notifier "${notifier.id}" failed for ${event.interactionId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    })();
  }
}
