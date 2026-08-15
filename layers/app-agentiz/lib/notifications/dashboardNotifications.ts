import type { Adminizer } from '@nodeknit/app-adminizer';
import { AgentizNotificationService } from './AgentizNotificationService';

/**
 * Sending an Agentiz notification to the Adminizer dashboard.
 *
 * The bell, the /dashboard/notifications page, read/unread state and the SSE stream all come from
 * adminizer; this module is only the seam between Agentiz's events and `adminizer.sendNotification`,
 * so no Agentiz service has to hold an Adminizer instance or ask whether the feature is on.
 *
 * Everything here is a no-op when the panel has notifications disabled (`notifications.enabled`,
 * off by default in adminizer) and before app-agentiz has mounted. Callers never check: a
 * notification that cannot be shown must not change what the caller does.
 */

/** `Notification.title`/`message` are `STRING` columns — 255 in every dialect we deploy on. */
const MAX_TITLE = 120;
const MAX_MESSAGE = 250;

export interface DashboardNotification {
  title: string;
  message: string;
  /** What kind of event this is (`interaction`, `run-failed`, …). Stored, and ours to define. */
  channel: string;
  /**
   * Recipient. Omitted means "everyone permitted to see the agentiz class" — for installation-wide
   * news only, never for anything naming one project's work.
   */
  userId?: number;
  /**
   * Anything worth keeping with the notification: the ids it came from, a deep link, whatever a
   * later reader needs. Stored as JSON on the notification row, so it is not length-limited.
   *
   * The stock bell renders only title and message — nothing in here is visible today. This is
   * storage, not display, which is why the human-readable part has to be in `message`.
   */
  metadata?: Record<string, unknown>;
}

// Shared mutable state has to hang off a global symbol: under tsx this module can be instantiated
// twice (ESM + CJS graphs), and a plain module-level variable would be set in one copy and read as
// null from the other.
const ADMINIZER_KEY = Symbol.for('agentiz.dashboardNotifications.adminizer');

function holder(): Record<symbol, Adminizer | null> {
  return globalThis as unknown as Record<symbol, Adminizer | null>;
}

function handlerOf(adminizer: Adminizer | null | undefined): any {
  return (adminizer as any)?.notificationHandler;
}

/**
 * Registers the panel to notify into and adds Agentiz's notification class to it.
 *
 * Returns whether notifications are actually available: `notificationHandler` exists only when the
 * panel was started with `notifications.enabled` (Adminizer.js binds it conditionally), and a panel
 * with the feature off is remembered but never sent to. The call site stays the same either way.
 */
export function useAdminizerNotifications(adminizer: Adminizer): boolean {
  holder()[ADMINIZER_KEY] = adminizer;
  const handler = handlerOf(adminizer);
  if (!handler) return false;
  // Re-mounting the layer must not register a second service under the same class.
  if (!handler.getService('agentiz')) handler.registerService(new AgentizNotificationService(adminizer));
  return true;
}

export function forgetAdminizerNotifications(): void {
  holder()[ADMINIZER_KEY] = null;
}

/** Whether a notification sent right now would reach anything. */
export function dashboardNotificationsEnabled(): boolean {
  return Boolean(handlerOf(holder()[ADMINIZER_KEY])?.getService('agentiz'));
}

function truncate(text: string, limit: number): string {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

/**
 * Stores and delivers one notification. Never throws and never rejects: the callers are event
 * handlers on paths that must not fail because the panel could not be told something.
 */
export async function sendDashboardNotification(notification: DashboardNotification): Promise<boolean> {
  const adminizer = holder()[ADMINIZER_KEY] as any;
  if (!handlerOf(adminizer)) return false;

  try {
    return await adminizer.sendNotification({
      notificationClass: 'agentiz',
      channel: notification.channel,
      title: truncate(notification.title, MAX_TITLE),
      message: truncate(notification.message, MAX_MESSAGE),
      userId: notification.userId,
      metadata: notification.metadata,
    });
  } catch (error) {
    console.warn('[app-agentiz] dashboard notification failed:', error instanceof Error ? error.message : error);
    return false;
  }
}
