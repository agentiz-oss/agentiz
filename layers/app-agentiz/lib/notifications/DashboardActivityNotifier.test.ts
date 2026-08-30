import { beforeEach, describe, expect, it, vi } from 'vitest';

// The notification service extends adminizer's abstract one; neither the panel nor its database is
// what this suite is about, so the whole package is a stub. `AbstractNotificationService` only has
// to keep the `adminizer` reference the subclass reads.
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
  AbstractNotificationService: class {
    protected adminizer: any;
    constructor(adminizer: any) {
      this.adminizer = adminizer;
    }
  },
}));

import type { ActivityEvent } from '../activityNotifiers';
import { DashboardActivityNotifier } from './DashboardActivityNotifier';
import {
  dashboardNotificationsEnabled,
  forgetAdminizerNotifications,
  sendDashboardNotification,
  useAdminizerNotifications,
} from './dashboardNotifications';

const OWNER = 21;

/** A panel with notifications switched on: a service registry plus the one method Agentiz calls. */
function panel() {
  const services = new Map<string, any>();
  return {
    sendNotification: vi.fn(async (_notification: any) => true),
    notificationHandler: {
      getService: (notificationClass: string) => services.get(notificationClass),
      registerService: (service: any) => services.set(service.notificationClass, service),
      getAllServices: () => [...services.values()],
    },
  };
}

function event(overrides: Partial<ActivityEvent['activity']> = {}, ownerId: number | null = OWNER): ActivityEvent {
  return {
    activity: {
      id: 'act-1',
      type: 'interaction.created',
      kind: 'action_required',
      projectId: 'p1',
      runId: 'run-1',
      taskId: 'task-1',
      proposalId: null,
      interactionId: 'int-1',
      title: 'Нужен ответ',
      body: 'Какую ветку использовать для релиза?',
      data: { source: 'codex' },
      createdAt: new Date(),
      ...overrides,
    },
    context: { ownerId, recipientIds: ownerId === null ? [] : [ownerId], projectName: 'Owned', taskTitle: 'Починить деплой', run: null },
    delivery: { push: 'on', dashboard: 'on' },
  };
}

/**
 * The path from a feed event to a row in the panel's bell. Two things carry the weight: the
 * notification has to be *addressed* (an unaddressed one is shown to every admin holding the
 * permission, and the event's text belongs to one project), and it has to survive a panel that has
 * the feature off, because that panel is the default.
 */
describe('DashboardActivityNotifier', () => {
  beforeEach(() => {
    forgetAdminizerNotifications();
  });

  it('addresses the project owner and keeps the ids on the record', async () => {
    const adminizer = panel();
    useAdminizerNotifications(adminizer as any);

    await new DashboardActivityNotifier().notify(event());

    expect(adminizer.sendNotification).toHaveBeenCalledTimes(1);
    const sent = adminizer.sendNotification.mock.calls[0][0] as any;
    expect(sent.userId).toBe(OWNER);
    expect(sent.notificationClass).toBe('agentiz');
    // The channel is the event type — that is what lets the bell filter per kind later.
    expect(sent.channel).toBe('interaction.created');
    // The bell shows nothing but these two, so the event has to be readable from them alone.
    expect(sent.title).toContain('Нужен ответ');
    expect(sent.title).toContain('Починить деплой');
    expect(sent.message).toBe('Какую ветку использовать для релиза?');
    expect(sent.metadata).toMatchObject({ activityId: 'act-1', interactionId: 'int-1', runId: 'run-1', projectId: 'p1' });
  });

  it('does nothing at all when the panel has notifications disabled', async () => {
    const adminizer = { sendNotification: vi.fn(async () => true) };

    expect(useAdminizerNotifications(adminizer as any)).toBe(false);
    expect(dashboardNotificationsEnabled()).toBe(false);

    await new DashboardActivityNotifier().notify(event());

    expect(adminizer.sendNotification).not.toHaveBeenCalled();
  });

  it('skips a project nobody owns instead of telling every admin', async () => {
    const adminizer = panel();
    useAdminizerNotifications(adminizer as any);

    await new DashboardActivityNotifier().notify(event({}, null));

    expect(adminizer.sendNotification).not.toHaveBeenCalled();
  });

  it('cuts title and message down to what the columns hold', async () => {
    const adminizer = panel();
    useAdminizerNotifications(adminizer as any);

    await new DashboardActivityNotifier().notify(event({ body: 'слово '.repeat(200) }));

    const sent = adminizer.sendNotification.mock.calls[0][0] as any;
    // STRING(255) truncates silently on sqlite/mysql and throws on postgres; neither is acceptable.
    expect(sent.message.length).toBeLessThanOrEqual(250);
    expect(sent.message.endsWith('…')).toBe(true);
  });

  it('swallows a panel that throws — a bell is never worth failing an emitter over', async () => {
    const adminizer = panel();
    adminizer.sendNotification.mockRejectedValue(new Error('database is gone') as never);
    useAdminizerNotifications(adminizer as any);

    await expect(sendDashboardNotification({ title: 't', message: 'm', channel: 'run.failed' })).resolves.toBe(false);
  });
});
