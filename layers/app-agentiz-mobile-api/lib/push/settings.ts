/**
 * Where every push provider reads its configuration.
 *
 * Two sources, in order: an overlay that an administrator has set (stored in
 * `agentiz_mobile_push_settings` and loaded into memory by `PushSettingsService`), then the process
 * environment. The environment stays the way a deployment is *configured*; the overlay is how it is
 * *administered* when editing `.env` and restarting is not on the table — which is the whole reason
 * a push credential can be installed over MCP.
 *
 * Read synchronously, because sending is on the worker's `requestHumanInput` path and must not wait
 * on a query. The overlay is small, and it is refreshed only when somebody changes it.
 *
 * No provider imports a model, and this module imports none either: the layer's models load the
 * overlay in, not the other way round.
 */

/** Every setting a push provider reads. The name is the environment variable's name, deliberately. */
export const PUSH_SETTING_KEYS = [
  'PUSH_PROVIDER',
  'AGENTIZ_FCM_SERVICE_ACCOUNT',
  'PUSH_GATEWAY_URL',
  'PUSH_GATEWAY_API_KEY',
  'PUSH_GATEWAY_TIMEOUT_MS',
  'AGENTIZ_APNS_KEY',
  'AGENTIZ_APNS_KEY_ID',
  'AGENTIZ_APNS_TEAM_ID',
  'AGENTIZ_APNS_BUNDLE_ID',
  'AGENTIZ_APNS_ENV',
] as const;

export type PushSettingKey = typeof PUSH_SETTING_KEYS[number];

/**
 * Values that can send notifications to every install of the app if they leak. Never returned in
 * full by anything — see {@link maskPushSetting}. The identifiers (key id, team id, bundle id) are
 * deliberately *not* here: they are needed to diagnose a `DeviceTokenNotForTopic` and are printed
 * on Apple's own web page.
 */
const SECRET_KEYS: ReadonlySet<string> = new Set<string>([
  'AGENTIZ_FCM_SERVICE_ACCOUNT',
  'PUSH_GATEWAY_API_KEY',
  'AGENTIZ_APNS_KEY',
]);

// Shared mutable state on a global symbol: under tsx this module can be instantiated twice (ESM +
// CJS graphs), and an overlay set in one copy would be invisible to the provider reading the other.
const OVERLAY_KEY = Symbol.for('agentiz.push.settingsOverlay');

function overlay(): Map<string, string> {
  const holder = globalThis as unknown as Record<symbol, Map<string, string>>;
  if (!holder[OVERLAY_KEY]) holder[OVERLAY_KEY] = new Map();
  return holder[OVERLAY_KEY];
}

export function isPushSettingKey(key: string): key is PushSettingKey {
  return (PUSH_SETTING_KEYS as readonly string[]).includes(key);
}

export function isSecretPushSetting(key: string): boolean {
  return SECRET_KEYS.has(key);
}

/** The value in force: what an administrator set, else the environment, else nothing. */
export function pushSetting(key: PushSettingKey): string | undefined {
  const stored = overlay().get(key);
  if (stored !== undefined && stored !== '') return stored;
  const fromEnv = process.env[key];
  return fromEnv === undefined || fromEnv === '' ? undefined : fromEnv;
}

export type PushSettingSource = 'database' | 'environment' | 'unset';

/** Which of the two sources answered — the first thing to check when a change "did not apply". */
export function pushSettingSource(key: PushSettingKey): PushSettingSource {
  if (overlay().has(key)) return 'database';
  return process.env[key] ? 'environment' : 'unset';
}

/** Replaces the whole overlay. Called by PushSettingsService after it reads or writes the table. */
export function replacePushSettingOverlay(values: Record<string, string>): void {
  const map = overlay();
  map.clear();
  for (const [key, value] of Object.entries(values)) {
    if (isPushSettingKey(key)) map.set(key, value);
  }
}

/** Test seam, and what `unmount()` leaves behind. */
export function clearPushSettingOverlay(): void {
  overlay().clear();
}

/**
 * What a value may be shown as. Secrets never come back — not their length, not a prefix that could
 * identify which key it is; only whether something is there at all.
 */
export function maskPushSetting(key: string, value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  return isSecretPushSetting(key) ? '••••••••' : value;
}
