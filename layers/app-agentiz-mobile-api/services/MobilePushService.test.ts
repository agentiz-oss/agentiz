import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));

// The providers are replaced wholesale: what is worth testing here is what the payload says, not
// whether Google answers. The providers themselves are covered in lib/push/providers.test.ts.
type Send = (message: any) => Promise<any>;
const sendFcmPush = vi.fn<Send>(async () => ({ success: true, messageId: 'fcm-1' }));
vi.mock('../lib/push/providers', () => ({
  pushConfigured: () => true,
  pushProvider: () => ({ name: 'fcm', configured: () => true, send: (message: any) => sendFcmPush(message) }),
}));

import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../../app-agentiz/models';
import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { AgentRun } from '../../app-agentiz/models/AgentRun';
import { AgentRunInteraction } from '../../app-agentiz/models/AgentRunInteraction';
import { AgentRunJob } from '../../app-agentiz/models/AgentRunJob';
import { AgentStageExecution } from '../../app-agentiz/models/AgentStageExecution';
import { AgentTask } from '../../app-agentiz/models/AgentTask';
import type { ActivityEvent } from '../../app-agentiz/lib/activityNotifiers';
import { MobileDevice } from '../models/MobileDevice';
import { MobileInboxDismissal } from '../models/MobileInboxDismissal';
import { MobileDeviceService } from './MobileDeviceService';
import { MobilePushService } from './MobilePushService';

const OWNER = 21;

/**
 * The push side of the activity fan-out. The dispatcher has already applied the policy and
 * resolved the context; what this layer owes is a payload the app can *open* — and, for
 * `interaction.created`, the exact legacy payload older builds still route questions on.
 */
describe('MobilePushService', () => {
  let sequelize: Sequelize;
  let interaction: AgentRunInteraction;
  let projectId: string;
  let runId: string;
  let taskId: string;

  beforeAll(async () => {
    sequelize = new Sequelize({
      dialect: 'sqlite',
      storage: ':memory:',
      logging: false,
      models: [...(Object.values(agentizModels) as any[]), MobileDevice, MobileInboxDismissal],
    });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  beforeEach(async () => {
    sendFcmPush.mockClear();
    sendFcmPush.mockImplementation(async () => ({ success: true, messageId: 'fcm-1' }));
    delete process.env.AGENTIZ_NOTIFY_POLICY;
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
    // An interaction is anchored to a real job and stage by foreign keys; the badge counts it too.
    const job = await AgentRunJob.create({
      runId: run.id,
      projectId: project.id,
      status: 'running',
      attempt: 1,
      snapshot: {},
    } as any);
    const stage = await AgentStageExecution.create({
      runId: run.id,
      stageIndex: 0,
      role: 'implement',
      agentRoleId: null,
      status: 'waiting_input',
    } as any);
    interaction = await AgentRunInteraction.create({
      projectId: project.id,
      runId: run.id,
      jobId: job.id,
      attempt: 1,
      stageExecutionId: stage.id,
      kind: 'elicitation',
      source: 'codex',
      externalRequestId: 'req-1',
      message: 'Какую ветку использовать для релиза?',
      requestedSchema: { type: 'object', properties: {} },
      status: 'pending',
    } as any);
    projectId = project.id;
    runId = run.id;
    taskId = task.id;
  });

  function interactionEvent(ownerId: number | null = OWNER): ActivityEvent {
    return {
      activity: {
        id: 'act-1',
        type: 'interaction.created',
        kind: 'action_required',
        projectId,
        runId,
        taskId,
        proposalId: null,
        interactionId: interaction.id,
        title: 'Нужен ответ',
        body: interaction.message,
        data: { source: 'codex' },
        createdAt: new Date(),
      },
      context: { ownerId, recipientIds: ownerId === null ? [] : [ownerId], projectName: 'Owned', taskTitle: 'Починить деплой', run: null },
      delivery: { push: 'on', dashboard: 'on' },
    };
  }

  function activityEvent(type: string, push: 'on' | 'silent' = 'on'): ActivityEvent {
    return {
      activity: {
        id: 'act-2',
        type,
        kind: type === 'run.failed' ? 'info' : 'action_required',
        projectId,
        runId,
        taskId,
        proposalId: 'prop-1',
        interactionId: null,
        title: 'Изменения ждут ревью',
        body: 'Ревизия 1 готова к проверке',
        data: {},
        createdAt: new Date(),
      },
      context: { ownerId: OWNER, recipientIds: [OWNER], projectName: 'Owned', taskTitle: 'Починить деплой', run: null },
      delivery: { push, dashboard: 'on' },
    };
  }

  it('keeps the legacy payload for interaction.created — old builds route on it', async () => {
    await MobileDeviceService.register(OWNER, { token: 'android-token', platform: 'android' });
    await MobileDeviceService.register(OWNER, { token: 'ios-token', platform: 'ios' });

    await new MobilePushService().notify(interactionEvent());

    expect(sendFcmPush).toHaveBeenCalledTimes(2);
    const message = sendFcmPush.mock.calls[0][0] as any;
    expect(message.data).toMatchObject({
      type: 'interaction',
      interactionId: interaction.id,
      runId,
      taskId,
      projectId,
      source: 'codex',
    });
    expect(message.notification.title).toBe('Починить деплой');
    expect(message.notification.body).toBe('Какую ветку использовать для релиза?');
    expect(message.android.priority).toBe('HIGH');
    expect(message.android.collapseKey).toBe(`agentiz-run-${runId}`);
    expect(message.apns.headers['apns-collapse-id']).toBe(`agentiz-run-${runId}`);
    expect(message.android.notification.channelId).toBe('agentiz-interactions');
    // The badge counts what needs the person — here, the one pending question.
    expect(message.apns.payload.aps.badge).toBe(1);
  });

  it('sends every other type as an openable activity payload', async () => {
    await MobileDeviceService.register(OWNER, { token: 'android-token', platform: 'android' });

    await new MobilePushService().notify(activityEvent('proposal.waiting_review'));

    const message = sendFcmPush.mock.calls[0][0] as any;
    expect(message.data).toMatchObject({
      type: 'activity',
      activityType: 'proposal.waiting_review',
      activityId: 'act-2',
      proposalId: 'prop-1',
      runId,
      projectId,
    });
    expect(message.android.notification.channelId).toBe('agentiz-actions');
    expect(message.android.priority).toBe('HIGH');
    expect(message.apns.payload.aps.sound).toBe('default');
  });

  it('delivers silent as quiet, not as absent', async () => {
    await MobileDeviceService.register(OWNER, { token: 'android-token', platform: 'android' });

    await new MobilePushService().notify(activityEvent('run.failed', 'silent'));

    expect(sendFcmPush).toHaveBeenCalledTimes(1);
    const message = sendFcmPush.mock.calls[0][0] as any;
    expect(message.android.priority).toBe('NORMAL');
    expect(message.android.notification.channelId).toBe('agentiz-results');
    expect(message.apns.payload.aps.sound).toBeUndefined();
  });

  it('does nothing without an addressee', async () => {
    await MobileDeviceService.register(OWNER, { token: 'android-token', platform: 'android' });

    await new MobilePushService().notify(interactionEvent(null));

    expect(sendFcmPush).not.toHaveBeenCalled();
  });

  it('leaves a muted project out of the badge count', async () => {
    await MobileDeviceService.register(OWNER, { token: 'android-token', platform: 'android' });
    process.env.AGENTIZ_NOTIFY_POLICY = JSON.stringify({ projects: { [projectId]: { 'interaction.created': { push: 'off' } } } });
    try {
      await new MobilePushService().notify(activityEvent('proposal.waiting_review'));
      const message = sendFcmPush.mock.calls[0][0] as any;
      // The pending question exists but its push is muted for this project — "не дёргай" includes
      // the badge; the waiting proposal is not in the database, so nothing else counts either.
      expect(message.apns.payload.aps.badge).toBe(0);
    } finally {
      delete process.env.AGENTIZ_NOTIFY_POLICY;
    }
  });

  it('forgets a token the transport reports as gone', async () => {
    await MobileDeviceService.register(OWNER, { token: 'dead-token', platform: 'android' });
    await MobileDeviceService.register(OWNER, { token: 'live-token', platform: 'android' });
    sendFcmPush.mockImplementation(async (message: any) => (message.token === 'dead-token'
      ? { success: false, reason: 'invalid-token' }
      : { success: true, messageId: 'fcm-1' }));

    await new MobilePushService().notify(interactionEvent());

    expect((await MobileDeviceService.forUser(OWNER)).map((device) => device.token)).toEqual(['live-token']);
  });

  it('keeps a token that merely failed to deliver', async () => {
    await MobileDeviceService.register(OWNER, { token: 'flaky-token', platform: 'android' });
    sendFcmPush.mockImplementation(async () => ({ success: false, reason: 'temporary-error', error: 'FCM 503' }));

    await new MobilePushService().notify(interactionEvent());

    expect((await MobileDeviceService.forUser(OWNER)).map((device) => device.token)).toEqual(['flaky-token']);
  });
});
