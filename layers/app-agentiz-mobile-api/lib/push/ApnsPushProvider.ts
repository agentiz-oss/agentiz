import http2, { type ClientHttp2Session } from 'http2';
import jwt from 'jsonwebtoken';
import {
  credentialSource,
  pushFailure,
  type PushMessage,
  type PushProvider,
  type PushResult,
} from './index';
import { pushSetting } from './settings';

/**
 * APNs over HTTP/2 with a token-based `.p8` key.
 *
 * Direct rather than through FCM on purpose: it keeps the Firebase SDK (and CocoaPods) out of the
 * iOS app, which then only has to hand its raw APNs device token to `POST /devices`.
 *
 * This one is **not** selected by `PUSH_PROVIDER`. That setting picks who forwards *FCM* tokens;
 * a raw APNs device token can only go to Apple, so a deployment that registers iOS devices this way
 * keeps using this provider whichever of the two is installed. An iOS app built on the Firebase SDK
 * registers an FCM token instead and never reaches here — the `apns` block of the message is then
 * applied by FCM, which is why it is part of the shared message rather than assembled here.
 *
 * Apple wants the connection kept alive and the authorisation JWT reused — a new one per push is
 * explicitly rate-limited — so both are cached.
 */

interface ApnsCredentials {
  key: string;
  keyId: string;
  teamId: string;
  topic: string;
  host: string;
}

/** Apple refuses tokens older than an hour and throttles ones minted too often; ~50 min is the norm. */
const JWT_TTL_MS = 50 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

/** Apple's reasons for "this token is not deliverable and never will be". */
const GONE_REASONS = /BadDeviceToken|Unregistered|DeviceTokenNotForTopic|TopicDisallowed/;

export class ApnsPushProvider implements PushProvider {
  readonly name = 'apns';

  private credentials: ApnsCredentials | null | undefined;
  private cachedJwt: { value: string; issuedAt: number } | null = null;
  private session: ClientHttp2Session | null = null;

  configured(): boolean {
    return this.config() !== null;
  }

  async send(message: PushMessage): Promise<PushResult> {
    const cfg = this.config();
    if (!cfg) return pushFailure('unknown', 'APNs is not configured');

    const payload = JSON.stringify(apnsPayload(message));
    const headers = message.apns?.headers ?? {};

    return new Promise<PushResult>((resolve) => {
      let settled = false;
      const finish = (result: PushResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      try {
        const request = this.connection(cfg).request({
          ':method': 'POST',
          ':path': `/3/device/${message.token}`,
          authorization: `bearer ${this.authToken(cfg)}`,
          'apns-topic': cfg.topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          ...headers,
          'content-type': 'application/json',
        });
        let status = 0;
        let apnsId = '';
        let body = '';
        request.setEncoding('utf8');
        request.on('response', (responseHeaders) => {
          status = Number(responseHeaders[':status'] ?? 0);
          apnsId = String(responseHeaders['apns-id'] ?? '');
        });
        request.on('data', (chunk: string) => {
          body += chunk;
        });
        request.on('error', (error) => finish(pushFailure('temporary-error', error.message)));
        request.on('end', () => {
          if (status === 200) return finish({ success: true, messageId: apnsId });
          if (status === 410 || GONE_REASONS.test(body)) {
            return finish(pushFailure('invalid-token', `APNs ${status}: ${body}`));
          }
          // 403 usually means the signing key or team id is wrong; re-mint on the next attempt so a
          // rotated key does not need a restart.
          if (status === 403) this.cachedJwt = null;
          const reason = status === 429 ? 'rate-limited' : status >= 500 ? 'temporary-error' : 'unknown';
          finish(pushFailure(reason, `APNs ${status}: ${body.slice(0, 300)}`));
        });
        request.setTimeout(REQUEST_TIMEOUT_MS, () => {
          request.close();
          finish(pushFailure('temporary-error', 'APNs request timed out'));
        });
        request.end(payload);
      } catch (error) {
        finish(pushFailure('temporary-error', error instanceof Error ? error.message : String(error)));
      }
    });
  }

  /** Closes the shared connection — the layer's `unmount()` must not leave a socket behind. */
  close(): void {
    this.session?.close();
    this.session = null;
  }

  private config(): ApnsCredentials | null {
    if (this.credentials !== undefined) return this.credentials;
    const key = credentialSource(pushSetting('AGENTIZ_APNS_KEY'));
    const keyId = (pushSetting('AGENTIZ_APNS_KEY_ID') ?? '').trim();
    const teamId = (pushSetting('AGENTIZ_APNS_TEAM_ID') ?? '').trim();
    const topic = (pushSetting('AGENTIZ_APNS_BUNDLE_ID') ?? '').trim();
    if (!key || !keyId || !teamId || !topic) {
      if (key || keyId || teamId || topic) {
        console.warn('[app-agentiz-mobile-api] APNs is half-configured; push to iOS stays off. Needs AGENTIZ_APNS_KEY, _KEY_ID, _TEAM_ID and _BUNDLE_ID');
      }
      this.credentials = null;
      return this.credentials;
    }
    this.credentials = {
      key,
      keyId,
      teamId,
      topic,
      // Sandbox is opt-in: a development build talking to the production host simply gets
      // BadDeviceToken, which is a far clearer symptom than the reverse.
      host: (pushSetting('AGENTIZ_APNS_ENV') ?? 'production') === 'sandbox'
        ? 'https://api.sandbox.push.apple.com'
        : 'https://api.push.apple.com',
    };
    return this.credentials;
  }

  private authToken(cfg: ApnsCredentials): string {
    if (this.cachedJwt && Date.now() - this.cachedJwt.issuedAt < JWT_TTL_MS) return this.cachedJwt.value;
    const value = jwt.sign({ iss: cfg.teamId, iat: Math.floor(Date.now() / 1000) }, cfg.key, {
      algorithm: 'ES256',
      header: { alg: 'ES256', kid: cfg.keyId },
    });
    this.cachedJwt = { value, issuedAt: Date.now() };
    return value;
  }

  private connection(cfg: ApnsCredentials): ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    const session = http2.connect(cfg.host);
    this.session = session;
    // Without a handler a transport-level error is an unhandled 'error' event, which takes the whole
    // process down over a push nobody was waiting for.
    session.on('error', (error) => {
      console.warn('[app-agentiz-mobile-api] APNs connection error:', error.message);
      if (this.session === session) this.session = null;
    });
    session.on('close', () => {
      if (this.session === session) this.session = null;
    });
    return session;
  }
}

/**
 * The body Apple expects. `apns.payload` is used as given — that is FCM's own convention, and it is
 * what lets one message work on both routes — with the shared `notification`/`data` filled in when
 * the caller did not spell the payload out.
 */
export function apnsPayload(message: PushMessage): Record<string, unknown> {
  const given = message.apns?.payload ?? {};
  return {
    // `data` also travels as custom keys on this route, the same way FCM copies it in.
    ...message.data,
    ...given,
    aps: {
      alert: { title: message.notification?.title, body: message.notification?.body },
      sound: 'default',
      ...(given.aps ?? {}),
    },
  };
}
