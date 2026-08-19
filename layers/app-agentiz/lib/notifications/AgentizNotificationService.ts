import { AbstractNotificationService } from '@nodeknit/app-adminizer';
import type { INotification } from '@nodeknit/app-adminizer';

/** What `dispatchNotification` is handed: everything the service itself does not fill in. */
export type DispatchedNotification = Omit<INotification, 'id' | 'createdAt' | 'notificationClass' | 'icon'>;

/**
 * Agentiz's own class of Adminizer notifications — the bell in the dashboard.
 *
 * A separate `notificationClass` rather than reusing adminizer's `general`, for three reasons: it
 * gets its own tab on /dashboard/notifications, it gets its own permission token
 * (`notification-agentiz`, registered by the base class) so it can be granted to the people who run
 * agents and to nobody else, and it can later be rendered differently without touching the panel's
 * other notifications.
 *
 * `dispatchNotification` is abstract in the base class and adminizer ships no reusable
 * implementation, so this mirrors GeneralNotificationService: addressed to one user when `userId`
 * is set, otherwise fanned out to everyone holding the permission.
 */
export class AgentizNotificationService extends AbstractNotificationService {
  readonly notificationClass = 'agentiz';
  readonly displayName = 'Agentiz';
  readonly icon = 'smart_toy';
  readonly iconColor = '#5987de';

  async dispatchNotification(notification: DispatchedNotification): Promise<boolean> {
    try {
      const stored = await this.notificationModel().create({
        ...notification,
        notificationClass: this.notificationClass,
      });

      if (notification.userId) {
        await this.createUserNotification(stored.id, notification.userId);
      } else {
        // Undirected: everyone allowed to see this class gets a row. For installation-wide news (a
        // worker going offline), never for anything naming one project's work — see
        // DashboardActivityNotifier, which always addresses the owner.
        const users = await this.userModel().find({});
        for (const user of users) {
          if (!this.adminizer.accessRightsHelper.hasPermission(`notification-${this.notificationClass}`, user)) continue;
          try {
            await this.createUserNotification(stored.id, user.id);
          } catch (error) {
            console.warn('[app-agentiz] could not create a user notification row:', error);
          }
        }
      }

      // Broadcast to every connected client is safe: the SSE endpoint drops a notification carrying
      // a userId for everyone but that user (NotificationController.getNotificationsStream).
      this.broadcast({
        type: 'notification',
        data: { ...stored, read: false, icon: { icon: this.icon, iconColor: this.iconColor } },
        notificationClass: this.notificationClass,
        userId: notification.userId ?? null,
      } as any);
      return true;
    } catch (error) {
      console.error('[app-agentiz] dashboard notification was not stored:', error);
      return false;
    }
  }
}
