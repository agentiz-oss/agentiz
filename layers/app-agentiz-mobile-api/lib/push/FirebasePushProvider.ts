import jwt from 'jsonwebtoken';
import {
  classifyHttpFailure,
  credentialSource,
  PUSH_HTTP_TIMEOUT_MS,
  pushFailure,
  type PushMessage,
  type PushProvider,
  type PushResult,
} from './index';
import { pushSetting } from './settings';

/**
 * FCM HTTP v1, spoken directly — the original transport, now behind {@link PushProvider}.
 *
 * The v1 API needs an OAuth2 access token rather than the old server key, which is the only real
 * work here: a service-account JWT is exchanged for a bearer token and cached until it expires.
 *
 * State is per instance rather than module-level so a test (or a re-mount) can build a fresh one
 * instead of reaching into a cache.
 */

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export class FirebasePushProvider implements PushProvider {
  readonly name = 'firebase';

  private account: ServiceAccount | null | undefined;
  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(private readonly rawCredential = pushSetting('AGENTIZ_FCM_SERVICE_ACCOUNT')) {}

  configured(): boolean {
    return this.serviceAccount() !== null;
  }

  async send(message: PushMessage): Promise<PushResult> {
    const sa = this.serviceAccount();
    if (!sa) return pushFailure('unknown', 'FCM is not configured');

    let bearer: string;
    try {
      bearer = await this.accessToken(sa);
    } catch (error) {
      // The exchange is a network call to Google, so a failure here is usually theirs, not ours.
      return pushFailure('temporary-error', error instanceof Error ? error.message : String(error));
    }

    let response: Response;
    try {
      response = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: toFcmMessage(message) }),
        signal: AbortSignal.timeout(PUSH_HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      return pushFailure('temporary-error', error instanceof Error ? error.message : String(error));
    }

    if (response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { name?: string };
      return { success: true, messageId: payload.name ?? '' };
    }
    const body = await response.text().catch(() => '');
    // 401/403 mean the credentials are wrong, not the token — drop the cached bearer so a rotated
    // key is picked up without a restart.
    if (response.status === 401 || response.status === 403) this.cachedToken = null;
    return pushFailure(classifyHttpFailure(response.status, body), `FCM ${response.status}: ${body.slice(0, 300)}`);
  }

  private serviceAccount(): ServiceAccount | null {
    if (this.account !== undefined) return this.account;
    const raw = credentialSource(this.rawCredential);
    if (!raw) {
      this.account = null;
      return this.account;
    }
    try {
      const parsed = JSON.parse(raw) as ServiceAccount;
      if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
        throw new Error('service account is missing project_id, client_email or private_key');
      }
      // Escaped newlines survive being carried through an env var; the PEM parser needs real ones.
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
      this.account = parsed;
    } catch (error) {
      console.error('[app-agentiz-mobile-api] AGENTIZ_FCM_SERVICE_ACCOUNT is not usable:', error);
      this.account = null;
    }
    return this.account;
  }

  private async accessToken(sa: ServiceAccount): Promise<string> {
    // A minute of slack: a token that expires in transit is indistinguishable from a bad one.
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60_000) return this.cachedToken.value;
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign(
      { iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 },
      sa.private_key,
      { algorithm: 'RS256' },
    );
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(PUSH_HTTP_TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!response.ok || !payload.access_token) {
      throw new Error(`FCM token exchange failed (${response.status}): ${payload.error_description ?? 'no access_token'}`);
    }
    this.cachedToken = { value: payload.access_token, expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000 };
    return this.cachedToken.value;
  }
}

/**
 * Our message *is* an FCM v1 message; this only drops the keys that were never set, because FCM
 * rejects a request carrying an explicit `null` where it expects an object.
 */
export function toFcmMessage(message: PushMessage): Record<string, unknown> {
  return {
    token: message.token,
    ...(message.notification ? { notification: message.notification } : {}),
    ...(message.data ? { data: message.data } : {}),
    ...(message.android ? { android: message.android } : {}),
    ...(message.apns ? { apns: message.apns } : {}),
  };
}
