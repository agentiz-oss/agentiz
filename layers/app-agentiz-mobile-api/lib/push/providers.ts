import { ApnsPushProvider } from './ApnsPushProvider';
import { FirebasePushProvider } from './FirebasePushProvider';
import { GatewayPushProvider } from './GatewayPushProvider';
import type { MobilePushTransport, PushProvider } from './index';

/**
 * Where the choice of transport is made — once, at start-up, from configuration.
 *
 * `PUSH_PROVIDER=firebase` (the default, and what every existing deployment keeps doing) sends to
 * FCM with a service account of our own. `PUSH_PROVIDER=gateway` forwards to a self-hosted push
 * gateway instead, and then the backend needs no Firebase credentials at all.
 *
 * Nothing above this file asks which one is installed: `providerFor()` hands back a
 * {@link PushProvider} and the caller only sends. That is the whole point — flipping the setting
 * must not touch a line of the sending logic.
 *
 * iOS is a second axis, not a second choice: a device registered with `transport: 'apns'` holds a
 * raw Apple token that only Apple can accept, so it always goes to {@link ApnsPushProvider}. A
 * device registered with `transport: 'fcm'` — Android, or an iOS build on the Firebase SDK — goes
 * to whichever provider the setting names, and its `apns` message block is honoured downstream.
 */

export type PushProviderName = 'firebase' | 'gateway';

export interface PushProviders {
  /** Handles FCM registration tokens: Firebase directly, or the gateway. */
  fcm: PushProvider;
  /** Handles raw APNs device tokens. Independent of `PUSH_PROVIDER`. */
  apns: PushProvider;
}

let providers: PushProviders | null = null;

/** Reads `PUSH_PROVIDER`, defaulting to the behaviour that predates this setting. */
export function configuredProviderName(): PushProviderName {
  const raw = (process.env.PUSH_PROVIDER ?? 'firebase').trim().toLowerCase();
  if (raw === 'gateway') return 'gateway';
  if (raw && raw !== 'firebase' && raw !== 'fcm') {
    console.warn(`[app-agentiz-mobile-api] unknown PUSH_PROVIDER "${raw}"; falling back to firebase`);
  }
  return 'firebase';
}

/** Builds the pair described by the environment. Exported for tests; the app uses {@link pushProviders}. */
export function createPushProviders(): PushProviders {
  return {
    fcm: configuredProviderName() === 'gateway' ? new GatewayPushProvider() : new FirebasePushProvider(),
    apns: new ApnsPushProvider(),
  };
}

/** The process-wide pair, built on first use and kept — both providers cache credentials and sockets. */
export function pushProviders(): PushProviders {
  if (!providers) providers = createPushProviders();
  return providers;
}

/** The provider that can address a device registered with this transport. */
export function providerFor(transport: MobilePushTransport): PushProvider {
  const resolved = pushProviders();
  return transport === 'apns' ? resolved.apns : resolved.fcm;
}

/** True when at least one route to a phone exists; false means push is simply off. */
export function pushConfigured(): boolean {
  const resolved = pushProviders();
  return resolved.fcm.configured() || resolved.apns.configured();
}

/** For logs: which providers are actually usable right now. */
export function pushProviderSummary(): string {
  const resolved = pushProviders();
  const parts = [
    `${resolved.fcm.name}${resolved.fcm.configured() ? '' : ' (unconfigured)'}`,
    `apns${resolved.apns.configured() ? '' : ' (unconfigured)'}`,
  ];
  return parts.join(', ');
}

/** Releases long-lived resources; call from the layer's `unmount()`. */
export function closePushProviders(): void {
  if (!providers) return;
  providers.fcm.close?.();
  providers.apns.close?.();
  providers = null;
}

/** Test seam: forget the resolved pair so the next call re-reads the environment. */
export function resetPushProviders(): void {
  closePushProviders();
}
