import {
  classifyHttpFailure,
  PUSH_HTTP_TIMEOUT_MS,
  pushFailure,
  type PushMessage,
  type PushProvider,
  type PushResult,
} from './index';
import { toFcmMessage } from './FirebasePushProvider';

/**
 * Sends through a self-hosted push gateway instead of talking to Google.
 *
 * The point is where the Firebase service account lives: with this provider installed the backend
 * holds none, only a URL and an API key, and the gateway is the single place that has to be trusted
 * with Google credentials.
 *
 * The request body is the FCM HTTP v1 body, unchanged (`POST /v1/messages:send` with `{ message }`),
 * so the gateway is a forwarding proxy rather than a protocol of its own — which is what makes
 * switching providers a configuration change: the `android` and `apns` blocks arrive at FCM exactly
 * as they would have from here.
 */
export class GatewayPushProvider implements PushProvider {
  readonly name = 'gateway';

  private readonly url: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(
    url = process.env.PUSH_GATEWAY_URL,
    apiKey = process.env.PUSH_GATEWAY_API_KEY,
    timeoutMs = Number(process.env.PUSH_GATEWAY_TIMEOUT_MS ?? PUSH_HTTP_TIMEOUT_MS),
  ) {
    // Trailing slash trimmed here rather than at every call site; the path is appended verbatim.
    this.url = (url ?? '').trim().replace(/\/+$/, '');
    this.apiKey = (apiKey ?? '').trim();
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : PUSH_HTTP_TIMEOUT_MS;
    if (this.url && !this.apiKey) {
      console.warn('[app-agentiz-mobile-api] PUSH_GATEWAY_URL is set without PUSH_GATEWAY_API_KEY; the gateway provider stays off');
    }
  }

  configured(): boolean {
    return Boolean(this.url && this.apiKey);
  }

  async send(message: PushMessage): Promise<PushResult> {
    if (!this.configured()) return pushFailure('unknown', 'push gateway is not configured');

    let response: Response;
    try {
      response = await fetch(`${this.url}/v1/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: toFcmMessage(message) }),
        // A gateway that stops answering must not hold the caller: delivery runs inside the
        // worker's human-input request, which is waiting on nothing else.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // A timeout and a refused connection are the same thing to the caller: the gateway may well
      // answer the next one, and nothing was delivered.
      const detail = error instanceof Error
        ? (error.name === 'TimeoutError' ? `push gateway timed out after ${this.timeoutMs}ms` : `push gateway unreachable: ${error.message}`)
        : String(error);
      return pushFailure('temporary-error', detail);
    }

    if (response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { name?: string; messageId?: string };
      // `name` is what FCM answers with; `messageId` is the friendlier alias a gateway may use.
      return { success: true, messageId: payload.messageId ?? payload.name ?? '' };
    }
    const body = await response.text().catch(() => '');
    return pushFailure(
      classifyHttpFailure(response.status, body),
      `push gateway ${response.status}: ${body.slice(0, 300)}`,
    );
  }
}
