import { readFileSync } from 'fs';

/**
 * Push delivery for the mobile client: one message model, one result model, several providers.
 *
 * The sending side is deliberately split in two. *What* to say lives in `MobilePushService`; *how*
 * it reaches a phone lives behind {@link PushProvider}, chosen once at start-up from
 * `PUSH_PROVIDER`. Sending through Firebase directly and sending through a self-hosted push gateway
 * are then the same call, and switching between them is a configuration change and nothing else.
 *
 * The message is deliberately shaped like an FCM HTTP v1 `message` — `token`, `notification`,
 * `data`, `android`, `apns` — rather than a friendlier invention of ours: the gateway forwards to
 * FCM in the end, so any shape of our own would only be translated back into this one, losing the
 * platform blocks on the way.
 *
 * Everything here is *optional*: with no credentials the providers report themselves unconfigured,
 * `MobilePushService` skips them, and the rest of the API behaves exactly as before. A deployment
 * without push is a supported deployment.
 */

export type MobilePushPlatform = 'android' | 'ios';
/** How a device is addressed: an FCM registration token, or a raw APNs device token. */
export type MobilePushTransport = 'fcm' | 'apns';

/** Android-specific delivery options, same names and meaning as FCM HTTP v1's `AndroidConfig`. */
export interface AndroidPushConfig {
  priority?: 'HIGH' | 'NORMAL';
  collapseKey?: string;
  notification?: {
    channelId?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** APNs-specific delivery options, same shape as FCM HTTP v1's `ApnsConfig`. */
export interface ApnsPushConfig {
  /** `apns-*` request headers; used verbatim when talking to Apple directly. */
  headers?: Record<string, string>;
  /** The APNs payload — `aps` plus any custom keys. */
  payload?: { aps?: Record<string, unknown>; [key: string]: unknown };
}

/**
 * One notification addressed at one device.
 *
 * Both providers take exactly this: there is no separate "gateway message". `data` is string-valued
 * because that is all FCM and APNs carry, and it is the half the app actually routes on — the
 * notification block is only what a human reads.
 */
export interface PushMessage {
  token: string;
  notification?: {
    title?: string;
    body?: string;
  };
  data?: Record<string, string>;
  android?: AndroidPushConfig;
  apns?: ApnsPushConfig;
}

/**
 * Why a send failed, in the only four categories the caller acts on:
 *
 * - `invalid-token` — the device is gone; delete the row, never retry.
 * - `rate-limited` — we are sending too fast; retryable.
 * - `temporary-error` — the far side broke or timed out; retryable.
 * - `unknown` — everything else, including bad credentials and malformed messages. Not retryable:
 *   repeating a request that was rejected for what it *is* only repeats the rejection.
 */
export type PushFailureReason = 'invalid-token' | 'rate-limited' | 'temporary-error' | 'unknown';

export interface PushSuccess {
  success: true;
  /** Whatever the far side called it — FCM's `name`, APNs' `apns-id`. Empty when it named nothing. */
  messageId: string;
}

export interface PushFailure {
  success: false;
  reason: PushFailureReason;
  error?: string;
}

export type PushResult = PushSuccess | PushFailure;

/**
 * The failure half of a result, or null.
 *
 * A helper rather than `if (!result.success)` at each call site: this project compiles without
 * `strict`, and discriminated-union narrowing is not reliable there.
 */
export function pushFailureOf(result: PushResult): PushFailure | null {
  return result.success ? null : (result as PushFailure);
}

/** True only for the two reasons a later attempt could plausibly change. */
export function isRetryable(result: PushResult): boolean {
  const reason = pushFailureOf(result)?.reason;
  return reason === 'rate-limited' || reason === 'temporary-error';
}

/** The device is unreachable for good and its row should go. */
export function isInvalidToken(result: PushResult): boolean {
  return pushFailureOf(result)?.reason === 'invalid-token';
}

export function pushFailure(reason: PushFailureReason, error?: string): PushResult {
  return { success: false, reason, ...(error ? { error } : {}) };
}

/**
 * A way to put one message on one device.
 *
 * Implementations are interchangeable by construction: they share this message and this result, so
 * nothing above them can tell which one is installed.
 */
export interface PushProvider {
  /** For logs and diagnostics — `firebase`, `gateway`, `apns`. */
  readonly name: string;
  /** False when its credentials are absent; the caller then skips it instead of failing sends. */
  configured(): boolean;
  send(message: PushMessage): Promise<PushResult>;
  /** Releases anything long-lived (APNs keeps an HTTP/2 session). */
  close?(): void;
}

/** Reads a credential that may be given inline or as a path to a file. */
export function credentialSource(value: string | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  // Inline JSON or an inline PEM — anything else is treated as a path.
  if (raw.startsWith('{') || raw.includes('-----BEGIN')) return raw;
  try {
    return readFileSync(raw, 'utf8');
  } catch (error) {
    console.warn(`[app-agentiz-mobile-api] push credential at ${raw} could not be read:`, error);
    return null;
  }
}

/** Shared HTTP timeout for the providers that speak to somebody over the network. */
export const PUSH_HTTP_TIMEOUT_MS = 10_000;

/**
 * Classifies an HTTP failure the way both the FCM and the gateway wire protocols report it — they
 * answer with the same status codes and the same `UNREGISTERED`-style error strings, because the
 * gateway is an FCM front end.
 */
export function classifyHttpFailure(status: number, body: string): PushFailureReason {
  if (status === 404) return 'invalid-token';
  if (status === 400 && /UNREGISTERED|INVALID_ARGUMENT|registration-token-not-registered/i.test(body) && /token/i.test(body)) {
    return 'invalid-token';
  }
  if (/UNREGISTERED|registration-token-not-registered/i.test(body)) return 'invalid-token';
  if (status === 429 || /QUOTA_EXCEEDED|RESOURCE_EXHAUSTED/i.test(body)) return 'rate-limited';
  if (status >= 500) return 'temporary-error';
  // 401/403 and the rest: the request itself is wrong, and sending it again would be too.
  return 'unknown';
}

// The providers import these types and helpers from here and are imported directly
// (`./push/FirebasePushProvider`, `./push/GatewayPushProvider`, `./push/ApnsPushProvider`) rather than
// re-exported, so this module stays a leaf and there is no import cycle to reason about.
