/**
 * Who gets told that something happened — the delivery side of the activity feed.
 *
 * app-agentiz owns the *events* (see services/ActivityService.ts) and this extension point, and
 * contributes no push notifier of its own: reaching a phone means device tokens and provider
 * credentials, which belong to whichever layer owns those devices (today app-agentiz-mobile-api).
 * The one notifier the core does register is the Adminizer bell (DashboardActivityNotifier),
 * whose recipient is a user of the panel this layer already runs inside.
 *
 * Registration goes through the `activityNotifiers` app-manager collection — see
 * ActivityNotifierCollection.ts — rather than a direct import, so a layer that is not installed
 * simply means nobody is listening.
 *
 * A notifier declares which *channel* it delivers on. The dispatcher resolves the notification
 * policy per channel and skips notifiers whose channel is off — a new notifier physically cannot
 * forget the policy check, and no delivery layer ever reads the policy itself.
 */

import type { AgentRun } from '../models/AgentRun';
import type { ActivityKind, ActivityPushMode, ActivityDashboardMode } from './notifications/activityTypes';

/** The stored feed row, as every channel sees it. */
export interface ActivityRecord {
  id: string;
  type: string;
  kind: ActivityKind;
  projectId: string;
  runId: string | null;
  taskId: string | null;
  proposalId: string | null;
  interactionId: string | null;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  createdAt: Date;
}

/**
 * Context the dispatcher resolved once, so notifiers stop each loading project/run/task on
 * their own.
 *
 * `recipientIds` is the addressee list — the project's owner plus everybody holding a membership
 * row in it (`lib/access/projectAccess.ts`, `recipientsForProject`). It replaces "шлём владельцу",
 * which was the rule of the whole mobile API before projects had members and which made every
 * event invisible to the people actually doing the work.
 */
export interface ActivityContext {
  /**
   * @deprecated The project's owner, kept for one release because notifiers are contributed by
   * layers and a layer may lag the core by a deploy. Read `recipientIds` instead — it already
   * contains the owner, and it is the only field that knows about anybody else.
   */
  ownerId: number | null;
  /** Everyone this event should reach in this project, owner first. */
  recipientIds: number[];
  projectName: string;
  taskTitle: string | null;
  run: AgentRun | null;
}

export interface ActivityEvent {
  activity: ActivityRecord;
  context: ActivityContext;
  /**
   * The delivery decision per channel, already resolved from the policy. A notifier whose channel
   * is `off` is never called at all; `silent` reaches the push notifier so it can lower priority
   * and drop the sound instead of dropping the message.
   */
  delivery: { push: ActivityPushMode; dashboard: ActivityDashboardMode };
}

export interface ActivityNotifier {
  /** Stable id of the contributing layer's notifier, used in logs and to replace on re-mount. */
  id: string;
  /** Which policy channel gates this notifier. Unknown channels are always delivered to. */
  channel: 'push' | 'dashboard' | string;
  notify(event: ActivityEvent): Promise<void> | void;
}

// Shared mutable state has to hang off a global symbol: under tsx this module can be instantiated
// twice (ESM + CJS graphs) and a plain module-level Map would silently split in two, leaving the
// notifier registered in one copy and the event emitted from the other.
const NOTIFIERS_KEY = Symbol.for('agentiz.activityNotifiers');

function registry(): Map<string, ActivityNotifier> {
  const holder = globalThis as unknown as Record<symbol, Map<string, ActivityNotifier>>;
  if (!holder[NOTIFIERS_KEY]) holder[NOTIFIERS_KEY] = new Map();
  return holder[NOTIFIERS_KEY];
}

export function registerActivityNotifier(notifier: ActivityNotifier): void {
  registry().set(notifier.id, notifier);
}

export function unregisterActivityNotifier(id: string): void {
  registry().delete(id);
}

export function listActivityNotifiers(): ActivityNotifier[] {
  return [...registry().values()];
}

/**
 * Fans one event out to every notifier whose channel the policy left on. Deliberately not awaited
 * by the dispatcher: some emitters sit inside the worker's `requestHumanInput` call, and a slow or
 * unreachable push service must not hold up — worse, fail — the agent's own request. Every
 * notifier is isolated, so one throwing still leaves the others delivered.
 */
export function dispatchActivity(event: ActivityEvent): void {
  for (const notifier of listActivityNotifiers()) {
    const mode = notifier.channel === 'push'
      ? event.delivery.push
      : notifier.channel === 'dashboard'
        ? event.delivery.dashboard
        : 'on';
    if (mode === 'off') continue;
    void (async () => {
      try {
        await notifier.notify(event);
      } catch (error) {
        console.warn(
          `[app-agentiz] activity notifier "${notifier.id}" failed for ${event.activity.type} ${event.activity.id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    })();
  }
}
