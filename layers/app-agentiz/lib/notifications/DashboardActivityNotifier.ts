import type { ActivityEvent, ActivityNotifier } from '../activityNotifiers';
import { dashboardNotificationsEnabled, sendDashboardNotification } from './dashboardNotifications';

/**
 * The Adminizer bell as an activity channel, alongside the phone.
 *
 * The recipient rule is the mobile one, deliberately — `context.recipientIds`, the project's owner
 * plus everybody holding a membership row in it, all of them Adminizer user ids. Both channels
 * therefore address the same people, and somebody watching the dashboard learns about a parked run,
 * a waiting review or a failed push without having the app installed.
 *
 * This lives in app-agentiz although the layer contributes no *push* notifier of its own: the rule
 * keeping delivery out of the core is about device tokens and provider credentials, and the
 * recipient here is a user of the very panel app-agentiz already runs inside.
 *
 * The bell renders only `title`/`message`, both capped at 255 — everything a person reads is in
 * them, and `metadata` keeps the ids a later reader (or a future deep link) needs.
 */
export class DashboardActivityNotifier implements ActivityNotifier {
  readonly id = 'app-agentiz:activity-dashboard';
  readonly channel = 'dashboard';

  async notify(event: ActivityEvent): Promise<void> {
    if (!dashboardNotificationsEnabled()) return;

    const { activity, context } = event;
    // Nobody in the project, nobody to tell. Deliberately not broadcast to every holder of the
    // permission instead: a notification with no `userId` goes to all of them, and the event's
    // text is that project's business.
    if (context.recipientIds.length === 0) return;

    // One row per person: the bell is addressed, and an unaddressed notification is a different
    // thing (installation-wide news), not a cheaper version of this one.
    for (const userId of context.recipientIds) {
      await sendDashboardNotification({
        channel: activity.type,
        title: `${activity.title} · ${context.taskTitle ?? context.projectName}`,
        message: activity.body,
        userId,
        metadata: {
          kind: activity.type,
          activityId: activity.id,
          runId: activity.runId ?? '',
          taskId: activity.taskId ?? '',
          proposalId: activity.proposalId ?? '',
          interactionId: activity.interactionId ?? '',
          projectId: activity.projectId,
          projectName: context.projectName,
          // Nothing renders this today; it is here so the record identifies what happened, and so a
          // link can be built from it the day the panel learns to open one.
          url: activity.interactionId ? '/dashboard/agentiz-interactions' : '/dashboard/agentiz',
          ...(activity.data ?? {}),
        },
      });
    }
  }
}
