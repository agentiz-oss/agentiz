import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The models are decorated for Adminizer, and the notification service extends adminizer's abstract
// one; neither the panel nor its database is what this suite is about, so the whole package is a
// stub. `AbstractNotificationService` only has to keep the `adminizer` reference the subclass reads.
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

import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../../models';
import { AgentProject } from '../../models/AgentProject';
import { AgentRun } from '../../models/AgentRun';
import { AgentTask } from '../../models/AgentTask';
import { DashboardInteractionNotifier } from './DashboardInteractionNotifier';
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
    // Typed argument, otherwise vi.fn infers an empty tuple and `mock.calls[0][0]` will not compile.
    sendNotification: vi.fn(async (_notification: any) => true),
    notificationHandler: {
      getService: (notificationClass: string) => services.get(notificationClass),
      registerService: (service: any) => services.set(service.notificationClass, service),
      getAllServices: () => [...services.values()],
    },
  };
}

/**
 * The path from "an agent asked something" to a row in the panel's bell.
 *
 * Two things carry the weight: the notification has to be *addressed* (an unaddressed one is shown
 * to every admin holding the permission, and the question text belongs to one project), and it has
 * to survive a panel that has the feature off, because that panel is the default.
 */
describe('DashboardInteractionNotifier', () => {
  let sequelize: Sequelize;
  let projectId: string;
  let runId: string;

  beforeAll(async () => {
    sequelize = new Sequelize({
      dialect: 'sqlite',
      storage: ':memory:',
      logging: false,
      models: Object.values(agentizModels) as any[],
    });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  beforeEach(async () => {
    forgetAdminizerNotifications();
    await sequelize.sync({ force: true });

    const project = await AgentProject.create({ name: 'Owned', slug: 'owned', ownerId: OWNER } as any);
    const task = await AgentTask.create({
      projectId: project.id,
      externalId: 'local:1',
      title: 'Починить деплой',
      status: 'in_progress',
      priority: 'normal',
    } as any);
    const run = await AgentRun.create({
      projectId: project.id,
      taskId: task.id,
      pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
      status: 'waiting_input',
      trigger: 'manual',
      currentStageIndex: 0,
    } as any);
    projectId = project.id;
    runId = run.id;
  });

  const event = (message = 'Какую ветку использовать для релиза?') => ({
    interactionId: 'int-1',
    projectId,
    runId,
    source: 'codex',
    message,
  });

  it('addresses the project owner and keeps the ids on the record', async () => {
    const adminizer = panel();
    useAdminizerNotifications(adminizer as any);

    await new DashboardInteractionNotifier().notifyCreated(event());

    expect(adminizer.sendNotification).toHaveBeenCalledTimes(1);
    const sent = adminizer.sendNotification.mock.calls[0][0] as any;
    expect(sent.userId).toBe(OWNER);
    expect(sent.notificationClass).toBe('agentiz');
    expect(sent.channel).toBe('interaction');
    // The bell shows nothing but these two, so the question has to be readable from them alone.
    expect(sent.title).toContain('Починить деплой');
    expect(sent.message).toBe('Какую ветку использовать для релиза?');
    // Not rendered anywhere today — kept so the row still identifies what was asked.
    expect(sent.metadata).toMatchObject({ kind: 'interaction', interactionId: 'int-1', runId, projectId });
  });

  it('registers the agentiz class once, however often the layer is mounted', async () => {
    const adminizer = panel();

    expect(useAdminizerNotifications(adminizer as any)).toBe(true);
    useAdminizerNotifications(adminizer as any);

    expect(adminizer.notificationHandler.getAllServices()).toHaveLength(1);
    expect(dashboardNotificationsEnabled()).toBe(true);
  });

  it('does nothing at all when the panel has notifications disabled', async () => {
    // No notificationHandler is exactly what adminizer leaves behind when notifications.enabled is
    // false — the default, so this is the shape most deployments have.
    const adminizer = { sendNotification: vi.fn(async () => true) };

    expect(useAdminizerNotifications(adminizer as any)).toBe(false);
    expect(dashboardNotificationsEnabled()).toBe(false);

    await new DashboardInteractionNotifier().notifyCreated(event());

    expect(adminizer.sendNotification).not.toHaveBeenCalled();
  });

  it('skips a project nobody owns instead of telling every admin', async () => {
    const adminizer = panel();
    useAdminizerNotifications(adminizer as any);
    await AgentProject.update({ ownerId: null } as any, { where: { id: projectId } });

    await new DashboardInteractionNotifier().notifyCreated(event());

    expect(adminizer.sendNotification).not.toHaveBeenCalled();
  });

  it('cuts title and message down to what the columns hold', async () => {
    const adminizer = panel();
    useAdminizerNotifications(adminizer as any);

    await new DashboardInteractionNotifier().notifyCreated(event('слово '.repeat(200)));

    const sent = adminizer.sendNotification.mock.calls[0][0] as any;
    // STRING(255) truncates silently on sqlite/mysql and throws on postgres; neither is acceptable.
    expect(sent.message.length).toBeLessThanOrEqual(250);
    expect(sent.message.endsWith('…')).toBe(true);
  });

  it('swallows a panel that throws — a bell is never worth failing an agent question over', async () => {
    const adminizer = panel();
    adminizer.sendNotification.mockRejectedValue(new Error('database is gone') as never);
    useAdminizerNotifications(adminizer as any);

    await expect(sendDashboardNotification({ title: 't', message: 'm', channel: 'interaction' })).resolves.toBe(false);
  });
});
