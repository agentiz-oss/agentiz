import type { ActivityEvent, ActivityNotifier } from '../../app-agentiz/lib/activityNotifiers';
import { activityTypeDef, ANDROID_CHANNEL_RESULTS } from '../../app-agentiz/lib/notifications/activityTypes';
import { isInvalidToken, isRetryable, pushFailureOf, type PushMessage, type PushResult } from '../lib/push';
import { pushConfigured, pushProvider } from '../lib/push/providers';
import { MobileDevice } from '../models/MobileDevice';
import { MobileActivityService } from './MobileActivityService';
import { MobileDeviceService } from './MobileDeviceService';

/** A notification is a preview, not the event: the details are read in the app. */
const MAX_BODY = 180;

function truncate(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

/**
 * Turns a feed event into a push on the phones of everybody in the project.
 *
 * This is the layer's `activityNotifiers` contribution (app-agentiz owns the events, see
 * app-agentiz/lib/activityNotifiers.ts). The dispatcher has already resolved the policy — this is
 * only called when push for the type is not off — and already resolved the recipients and the task
 * context, so nothing here loads a model beyond the device rows. Who the recipients are is not this
 * layer's business: `context.recipientIds` is the project's owner plus its members, decided once in
 * `lib/access/projectAccess.ts`.
 *
 * The payload's job is to be openable. For `interaction.created` it is **bit-for-bit the legacy
 * shape** (`type=interaction` + `interactionId` + task/project context): older app builds route
 * questions on exactly that, and a question must survive a server deploy the phone has not caught
 * up with. Every other type travels as `type=activity` — an old build shows it as a plain banner
 * without deep-routing (its Push.kt returns null for unknown types), which is the intended soft
 * degradation.
 *
 * `delivery.push === 'silent'` keeps the message but takes the noise out: normal priority, the
 * low-importance results channel on Android, no sound-worthy alert anywhere.
 *
 * Nothing here knows how a message travels. It builds one `PushMessage` and hands it to the
 * configured provider (`lib/push/providers.ts`), so `PUSH_PROVIDER=firebase` and
 * `PUSH_PROVIDER=gateway` run exactly this code.
 */
export class MobilePushService implements ActivityNotifier {
  readonly id = 'app-agentiz-mobile-api:activity-push';
  readonly channel = 'push';

  static configured(): boolean {
    return pushConfigured();
  }

  async notify(event: ActivityEvent): Promise<void> {
    if (!MobilePushService.configured()) return;

    const { activity, context } = event;
    // Nobody in the project, nobody to notify. A project with no owner and no members is still
    // invisible to every mobile user, which is the same blind spot as before — it is just no
    // longer the owner alone that closes it.
    if (context.recipientIds.length === 0) return;

    const silent = event.delivery.push === 'silent';
    const def = activityTypeDef(activity.type);

    // One notification per run: a run that raises several events in a row replaces its own card
    // instead of burying the phone. Events without a run collapse per proposal, then per activity.
    const collapseId = activity.runId
      ? `agentiz-run-${activity.runId}`
      : activity.proposalId
        ? `agentiz-proposal-${activity.proposalId}`
        : `agentiz-activity-${activity.id}`;

    const data: Record<string, string> = activity.type === 'interaction.created'
      ? {
          type: 'interaction',
          interactionId: activity.interactionId ?? '',
          runId: activity.runId ?? '',
          projectId: activity.projectId,
          projectName: context.projectName,
          taskId: activity.taskId ?? '',
          taskTitle: context.taskTitle ?? '',
          source: String(activity.data?.source ?? ''),
        }
      : {
          type: 'activity',
          activityType: activity.type,
          activityId: activity.id,
          kind: activity.kind,
          runId: activity.runId ?? '',
          taskId: activity.taskId ?? '',
          taskTitle: context.taskTitle ?? '',
          proposalId: activity.proposalId ?? '',
          projectId: activity.projectId,
          projectName: context.projectName,
          ...(typeof activity.data?.prUrl === 'string' ? { prUrl: activity.data.prUrl } : {}),
        };

    const message = (badge: number): PushMessage => ({
      // Filled in per device — everything else about the message is the same for all of them.
      token: '',
      notification: {
        title: context.taskTitle
          ? truncate(context.taskTitle, 60)
          : `${activity.title} · ${context.projectName}`,
        body: truncate(activity.type === 'interaction.created' ? activity.body : `${activity.title}. ${activity.body}`.trim(), MAX_BODY),
      },
      data,
      android: {
        // Waking the device is what an actionable event is for; a silenced one keeps normal
        // priority and lands on the low-importance channel, so the OS shows it without a sound.
        priority: silent ? 'NORMAL' : 'HIGH',
        collapseKey: collapseId,
        notification: { channelId: silent ? ANDROID_CHANNEL_RESULTS : def.androidChannel },
      },
      apns: {
        headers: { 'apns-collapse-id': collapseId.slice(0, 64) },
        payload: {
          aps: {
            badge,
            // Groups every event of one run into a single notification stack.
            'thread-id': collapseId,
            ...(silent ? {} : { sound: 'default' }),
          },
        },
      },
    });

    // One message per person, because the badge is per person: it counts what still needs *them*,
    // honouring their own mutes (MobileActivityService.badgeCount). Recipients are handled in
    // parallel and independently — a person with no device, or a provider failing for one of them,
    // must not stop the rest.
    await Promise.all(context.recipientIds.map(async (recipientId) => {
      const userId = Number(recipientId);
      const devices = await MobileDeviceService.forUser(userId);
      if (devices.length === 0) return;
      await MobilePushService.deliver(devices, message(await MobileActivityService.badgeCount(userId)));
    }));
  }

  /**
   * Sends to every device in parallel and prunes whatever came back dead. Failures are logged and
   * swallowed: a push that does not arrive must never affect the run it is about — the event is
   * still in the app's feed either way.
   *
   * There is no retry here on purpose. Delivery can run inside the worker's `requestHumanInput`
   * call, so waiting out a rate limit would delay the agent for a notification; a retryable
   * failure is logged as such and the next event re-notifies. What is *not* postponed is
   * `invalid-token`: that device is gone for good and its row goes with it, or every later push
   * repeats the failure.
   */
  private static async deliver(devices: MobileDevice[], message: PushMessage): Promise<void> {
    const results = await Promise.all(devices.map(async (device) => {
      const result: PushResult = await pushProvider().send({ ...message, token: device.token });
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
