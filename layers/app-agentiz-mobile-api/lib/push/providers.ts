import { FirebasePushProvider } from './FirebasePushProvider';
import { GatewayPushProvider } from './GatewayPushProvider';
import type { PushProvider } from './index';
import { pushSetting } from './settings';

/**
 * Where the choice of transport is made — once, at start-up, from configuration.
 *
 * `PUSH_PROVIDER=firebase` (the default, and what every existing deployment keeps doing) sends to
 * FCM with a service account of our own. `PUSH_PROVIDER=gateway` forwards to a self-hosted push
 * gateway instead, and then the backend needs no Firebase credentials at all.
 *
 * Nothing above this file asks which one is installed: `pushProvider()` hands back a
 * {@link PushProvider} and the caller only sends. That is the whole point — flipping the setting
 * must not touch a line of the sending logic.
 *
 * iOS is not a second axis any more: the app carries the Firebase SDK and registers an FCM token
 * like Android does, so both platforms travel this one route and the `apns` block of the message is
 * applied downstream by FCM. Talking to Apple directly is gone — with it went the deployment-wide
 * choice of APNs host, which Google now makes per token.
 */

export type PushProviderName = 'firebase' | 'gateway';

export interface PushProviders {
  /** Handles FCM registration tokens: Firebase directly, or the gateway. The only route there is. */
  fcm: PushProvider;
}

// Not a module-level `let`: an administrator changing a credential resets this cache, and under tsx
// a module can be instantiated twice — a reset applied to one copy would leave the other still
// sending with the old provider.
const PROVIDERS_KEY = Symbol.for('agentiz.push.providers');

function cache(): { value: PushProviders | null } {
  const holder = globalThis as unknown as Record<symbol, { value: PushProviders | null }>;
  if (!holder[PROVIDERS_KEY]) holder[PROVIDERS_KEY] = { value: null };
  return holder[PROVIDERS_KEY];
}

/** Reads `PUSH_PROVIDER`, defaulting to the behaviour that predates this setting. */
export function configuredProviderName(): PushProviderName {
  const raw = (pushSetting('PUSH_PROVIDER') ?? 'firebase').trim().toLowerCase();
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
  };
}

/** Built on first use and kept — the provider caches credentials and its HTTP connection. */
export function pushProviders(): PushProviders {
  const held = cache();
  if (!held.value) held.value = createPushProviders();
  return held.value;
}

/** The provider every device is addressed through. */
export function pushProvider(): PushProvider {
  return pushProviders().fcm;
}

/** True when a route to a phone exists; false means push is simply off. */
export function pushConfigured(): boolean {
  return pushProviders().fcm.configured();
}

/** For logs: whether the provider is actually usable right now. */
export function pushProviderSummary(): string {
  const { fcm } = pushProviders();
  return `${fcm.name}${fcm.configured() ? '' : ' (unconfigured)'}`;
}

/** Releases long-lived resources; call from the layer's `unmount()`. */
export function closePushProviders(): void {
  const held = cache();
  if (!held.value) return;
  held.value.fcm.close?.();
  held.value = null;
}

/**
 * Forgets the resolved pair so the next send re-reads configuration.
 *
 * Called after an administrator changes a setting (PushSettingsService), which is what makes a new
 * credential or a new `PUSH_PROVIDER` take effect without restarting the process — and also the
 * test seam for the environment-driven path.
 */
export function resetPushProviders(): void {
  closePushProviders();
}
