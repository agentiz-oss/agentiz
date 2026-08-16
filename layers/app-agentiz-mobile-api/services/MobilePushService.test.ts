import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));

// The providers are replaced wholesale: what is worth testing here is who gets addressed and what
// the payload says, not whether Google and Apple answer. The providers themselves are covered in
// lib/push/providers.test.ts.
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
import { MobileDevice } from '../models/MobileDevice';
import { MobileDeviceService } from './MobileDeviceService';
import { MobilePushService } from './MobilePushService';

const OWNER = 21;
const STRANGER = 22;

/**
 * The path from "an agent asked something" to a notification on the right phone. The push exists to
 * be *opened*, so the assertions are mostly about the data payload: without `interactionId` the app
 * has nothing to navigate to and the notification is just noise.
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
      models: [...(Object.values(agentizModels) as any[]), MobileDevice],
    });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  beforeEach(async () => {
    sendFcmPush.mockClear();
    sendFcmPush.mockImplementation(async () => ({ success: true, messageId: 'fcm-1' }));
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
    // An interaction is anchored to a real job and stage by foreign keys, so both have to exist
    // even though the notification never looks at them.
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

  const event = () => ({
    interactionId: interaction.id,
    projectId,
    runId,
    source: 'codex',
    message: interaction.message,
  });

  it('reaches every device of the project owner — both platforms over FCM', async () => {
    await MobileDeviceService.register(OWNER, { token: 'android-token', platform: 'android' });
    await MobileDeviceService.register(OWNER, { token: 'ios-token', platform: 'ios' });

    await new MobilePushService().notifyCreated(event());

    expect(sendFcmPush).toHaveBeenCalledTimes(2);
    expect(sendFcmPush.mock.calls.map((call) => call[0].token)).toEqual(['android-token', 'ios-token']);

    const message = sendFcmPush.mock.calls[0][0] as any;
    // The tap target. Everything else in the payload is context the app could re-fetch; this it
    // cannot guess.
    expect(message.data).toMatchObject({
      type: 'interaction',
      interactionId: interaction.id,
      runId,
      taskId,
      projectId,
    });
    expect(message.notification.title).toBe('Починить деплой');
    expect(message.notification.body).toBe('Какую ветку использовать для релиза?');
    // One card per run, so a chatty stage cannot bury the phone — and the same run is one card on
    // both platforms, which is why the two blocks say it in their own dialects.
    expect(message.android.collapseKey).toBe(`agentiz-run-${runId}`);
    expect(message.apns.headers['apns-collapse-id']).toBe(`agentiz-run-${runId}`);
    expect(message.android.notification.channelId).toBe('agentiz-interactions');
  });

  it('carries the platform blocks whichever provider is installed', async () => {
    await MobileDeviceService.register(OWNER, { token: 'ios-token', platform: 'ios' });

    await new MobilePushService().notifyCreated(event());

    // Forwarded to Apple by FCM itself — that is the whole reason the block travels in the message
    // rather than being assembled next to a connection of ours.
    const message = sendFcmPush.mock.calls[0][0] as any;
    expect(message.apns.payload.aps['thread-id']).toBe(`agentiz-run-${runId}`);
    expect(message.apns.payload.aps.badge).toBe(1);
  });

  it('never notifies anyone but the project owner', async () => {
    await MobileDeviceService.register(STRANGER, { token: 'stranger-token', platform: 'android' });

    await new MobilePushService().notifyCreated(event());

    expect(sendFcmPush).not.toHaveBeenCalled();
  });

  it('forgets a token the transport reports as gone', async () => {
    await MobileDeviceService.register(OWNER, { token: 'dead-token', platform: 'android' });
    await MobileDeviceService.register(OWNER, { token: 'live-token', platform: 'android' });
    sendFcmPush.mockImplementation(async (message: any) => (message.token === 'dead-token'
      ? { success: false, reason: 'invalid-token' }
      : { success: true, messageId: 'fcm-1' }));

    await new MobilePushService().notifyCreated(event());

    expect((await MobileDeviceService.forUser(OWNER)).map((device) => device.token)).toEqual(['live-token']);
  });

  it('keeps a token that merely failed to deliver', async () => {
    await MobileDeviceService.register(OWNER, { token: 'flaky-token', platform: 'android' });
    sendFcmPush.mockImplementation(async () => ({ success: false, reason: 'temporary-error', error: 'FCM 503' }));

    await new MobilePushService().notifyCreated(event());

    expect((await MobileDeviceService.forUser(OWNER)).map((device) => device.token)).toEqual(['flaky-token']);
  });

  it('moves a token to whoever registered it last', async () => {
    await MobileDeviceService.register(STRANGER, { token: 'shared-phone', platform: 'ios' });
    // The same phone, signed in as somebody else: the previous user's questions must stop arriving
    // on it rather than both users being notified.
    await MobileDeviceService.register(OWNER, { token: 'shared-phone', platform: 'ios' });

    expect(await MobileDeviceService.forUser(STRANGER)).toHaveLength(0);
    await new MobilePushService().notifyCreated(event());
    expect(sendFcmPush).toHaveBeenCalledTimes(1);
  });

  /** An older build still names a transport; it is accepted and ignored rather than rejected. */
  it('takes a registration that names a transport, and sends to it all the same', async () => {
    await MobileDeviceService.register(OWNER, { token: 'ios-token', platform: 'ios', transport: 'apns' });

    await new MobilePushService().notifyCreated(event());

    expect(sendFcmPush).toHaveBeenCalledTimes(1);
    expect(sendFcmPush.mock.calls[0][0].token).toBe('ios-token');
  });

  it('rejects a registration without a usable platform', async () => {
    await expect(MobileDeviceService.register(OWNER, { token: 'x', platform: 'symbian' })).rejects.toThrow(/platform/);
    await expect(MobileDeviceService.register(OWNER, { token: '  ', platform: 'ios' })).rejects.toThrow(/token/);
  });
});
