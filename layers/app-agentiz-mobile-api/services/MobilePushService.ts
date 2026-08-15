import { Op } from 'sequelize';
import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { AgentRun } from '../../app-agentiz/models/AgentRun';
import { AgentRunInteraction } from '../../app-agentiz/models/AgentRunInteraction';
import { AgentTask } from '../../app-agentiz/models/AgentTask';
import type { InteractionCreatedEvent, InteractionNotifier } from '../../app-agentiz/lib/interactionNotifiers';
import { isInvalidToken, isRetryable, pushFailureOf, type PushMessage, type PushResult } from '../lib/push';
import { providerFor, pushConfigured } from '../lib/push/providers';
import { MobileDevice } from '../models/MobileDevice';
import { MobileDeviceService } from './MobileDeviceService';

/** A notification is a preview, not the question: the form is read in the app. */
const MAX_BODY = 180;

function truncate(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

/**
 * Turns "an agent is waiting for a human" into a push on that human's phones.
 *
 * This is the layer's `interactionNotifiers` contribution (app-agentiz owns the event, see
 * app-agentiz/lib/interactionNotifiers.ts). The recipient is the *project's owner*, which is the
 * same rule the whole mobile API is scoped by: a person sees, and is told about, exactly the
 * projects whose `ownerId` is theirs.
 *
 * The payload's job is to be openable. `type=interaction` plus `interactionId` is what the app
 * routes on, and taskId/projectId/projectName are carried along so the question's page can be built
 * without a round trip while the app is still starting up.
 *
 * Nothing here knows how a message travels. It builds one `PushMessage` and hands it to the
 * provider that can address each device (`lib/push/providers.ts`), so `PUSH_PROVIDER=firebase` and
 * `PUSH_PROVIDER=gateway` run exactly this code.
 */
export class MobilePushService implements InteractionNotifier {
  readonly id = 'app-agentiz-mobile-api:interaction-push';

  static configured(): boolean {
    return pushConfigured();
  }

  async notifyCreated(event: InteractionCreatedEvent): Promise<void> {
    if (!MobilePushService.configured()) return;

    const project = await AgentProject.findByPk(event.projectId);
    // No owner means nobody to notify — the same blind spot the API has by design: a project with
    // no `ownerId` is invisible to every mobile user.
    if (!project?.ownerId) return;
    const userId = Number(project.ownerId);
    const devices = await MobileDeviceService.forUser(userId);
    if (devices.length === 0) return;

    const run = await AgentRun.findByPk(event.runId);
    const task = run ? await AgentTask.findByPk(run.taskId) : null;

    // One notification per run: a stage that asks twice in a row replaces its own card instead of
    // burying the phone in near-identical questions.
    const collapseId = `agentiz-run-${event.runId}`;
    const badge = await MobilePushService.pendingCount(userId);
    const message: PushMessage = {
      // Filled in per device — everything else about the message is the same for all of them.
      token: '',
      notification: {
        title: task?.title ? truncate(task.title, 60) : `Вопрос агента · ${project.name}`,
        body: truncate(event.message, MAX_BODY),
      },
      data: {
        type: 'interaction',
        interactionId: event.interactionId,
        runId: event.runId,
        projectId: event.projectId,
        projectName: project.name ?? '',
        taskId: run?.taskId ?? '',
        taskTitle: task?.title ?? '',
        source: event.source,
      },
      android: {
        // A parked run is the whole point of the notification, so it is worth waking the device.
        priority: 'HIGH',
        collapseKey: collapseId,
        notification: { channelId: 'agentiz-interactions' },
      },
      apns: {
        headers: { 'apns-collapse-id': collapseId.slice(0, 64) },
        payload: {
          aps: {
            badge,
            // Groups every question of one run into a single notification stack.
            'thread-id': collapseId,
          },
        },
      },
    };

    await MobilePushService.deliver(devices, message);
  }

  /** How many questions this person now has open — the number the iOS badge shows. */
  private static async pendingCount(userId: number): Promise<number> {
    const projects = await AgentProject.findAll({ where: { ownerId: userId as any }, attributes: ['id'] });
    if (projects.length === 0) return 0;
    return AgentRunInteraction.count({
      where: { projectId: { [Op.in]: projects.map((project) => project.id) }, status: 'pending' },
    });
  }

  /**
   * Sends to every device in parallel and prunes whatever came back dead. Failures are logged and
   * swallowed: a push that does not arrive must never affect the run it is about — the question is
   * still in the app's list either way.
   *
   * There is no retry here on purpose. Delivery runs inside the worker's `requestHumanInput` call,
   * so waiting out a rate limit would delay the agent for a notification; a retryable failure is
   * logged as such and the next question re-notifies. What is *not* postponed is `invalid-token`:
   * that device is gone for good and its row goes with it, or every later push repeats the failure.
   */
  private static async deliver(devices: MobileDevice[], message: PushMessage): Promise<void> {
    const results = await Promise.all(devices.map(async (device) => {
      const result: PushResult = await providerFor(device.transport).send({ ...message, token: device.token });
      const failure = pushFailureOf(result);
      if (failure && failure.reason !== 'invalid-token') {
        const kind = isRetryable(result) ? 'failed (retryable)' : 'failed';
        console.warn(`[app-agentiz-mobile-api] push to ${device.platform} device ${kind}: ${failure.reason} — ${failure.error ?? ''}`);
      }
      return { device, result };
    }));

    const dead = results.filter((entry) => isInvalidToken(entry.result)).map((entry) => entry.device.token);
    if (dead.length > 0) {
      await MobileDeviceService.forget(dead);
      console.log(`[app-agentiz-mobile-api] dropped ${dead.length} unreachable push token(s)`);
    }
  }
}
