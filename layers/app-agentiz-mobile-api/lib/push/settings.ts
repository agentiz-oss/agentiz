/**
 * Where every push provider reads its configuration.
 *
 * These are app-manager settings — declared as slots in the layer's `settings` collection, stored in
 * the `settings` table, held in `appManager.settingStorage`. Not a table of this layer's own: the
 * platform already has one mechanism for "a value an administrator can change without a deploy", and
 * a second one would mean two places to look for the same kind of answer.
 *
 * **The environment wins.** That is app-manager's rule (`SettingStorage.get` checks `process.env`
 * first), and it is the reason a value set here can look ignored: a key that is also in `.env` keeps
 * the `.env` value until that variable is removed. `pushSettingSource()` reports which of the two
 * answered, and PushSettingsService turns a shadowed write into a warning rather than a surprise.
 *
 * Read synchronously, because sending is on the worker's `requestHumanInput` path and must not wait
 * on a query — `settingStorage` is in memory, loaded when the collection was processed.
 *
 * No provider imports a model or the AppManager: the layer hands the manager in at mount, and until
 * it does (or in a unit test) everything here falls back to the environment on its own.
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

/** The shape app-manager's SettingHandler instantiates. Not imported: the package exports no type. */
export interface PushSettingSlot {
  key: string;
  type: 'string' | 'boolean' | 'json' | 'number';
  name?: string;
  description?: string;
  value?: unknown;
}

/** What `settingStorage` has to look like for this module — the two methods it actually calls. */
interface SettingStorageLike {
  get(settingClass: new () => PushSettingSlot): unknown;
  getSettingSlot(key: string): PushSettingSlot | undefined;
}

interface AppManagerLike {
  settingStorage?: SettingStorageLike;
}

function slot(
  settingKey: PushSettingKey,
  settingName: string,
  settingDescription: string,
  settingType: PushSettingSlot['type'] = 'string',
) {
  // A class, because app-manager's SettingHandler does `new item()` on every collection entry.
  return class implements PushSettingSlot {
    key = settingKey;
    type = settingType;
    name = settingName;
    description = settingDescription;
  };
}

/**
 * The slots this layer contributes to app-manager's `settings` collection.
 *
 * Declaring them is what makes a value storable at all: `Setting.beforeSave` refuses a key with no
 * registered slot, which is also why an unknown key cannot be written by accident.
 */
export const PUSH_SETTING_SLOTS: Record<PushSettingKey, new () => PushSettingSlot> = {
  PUSH_PROVIDER: slot('PUSH_PROVIDER', 'Push provider', 'How FCM tokens are delivered: "firebase" (directly) or "gateway".'),
  AGENTIZ_FCM_SERVICE_ACCOUNT: slot('AGENTIZ_FCM_SERVICE_ACCOUNT', 'Firebase service account', 'Service-account JSON, inline or a path to the file. Enables Android push.'),
  PUSH_GATEWAY_URL: slot('PUSH_GATEWAY_URL', 'Push gateway URL', 'Base URL of the push gateway, used when the provider is "gateway".'),
  PUSH_GATEWAY_API_KEY: slot('PUSH_GATEWAY_API_KEY', 'Push gateway API key', 'Bearer key the gateway accepts.'),
  PUSH_GATEWAY_TIMEOUT_MS: slot('PUSH_GATEWAY_TIMEOUT_MS', 'Push gateway timeout', 'Hard timeout on a gateway request, in milliseconds.', 'number'),
  AGENTIZ_APNS_KEY: slot('AGENTIZ_APNS_KEY', 'APNs key', 'Contents of the .p8 signing key, or a path to it.'),
  AGENTIZ_APNS_KEY_ID: slot('AGENTIZ_APNS_KEY_ID', 'APNs key id', 'The 10-character Key ID of that .p8.'),
  AGENTIZ_APNS_TEAM_ID: slot('AGENTIZ_APNS_TEAM_ID', 'Apple team id', 'The 10-character Apple developer team id.'),
  AGENTIZ_APNS_BUNDLE_ID: slot('AGENTIZ_APNS_BUNDLE_ID', 'App bundle id', "The app's bundle id, sent to Apple as the APNs topic."),
  AGENTIZ_APNS_ENV: slot('AGENTIZ_APNS_ENV', 'APNs environment', '"production", or "sandbox" for development builds of the app.'),
};

export const pushSettingSlots: (new () => PushSettingSlot)[] = Object.values(PUSH_SETTING_SLOTS);

// The AppManager reference lives on a global symbol: under tsx this module can be instantiated twice
// (ESM + CJS graphs), and a manager registered in one copy would be invisible to the provider
// reading the other.
const MANAGER_KEY = Symbol.for('agentiz.push.settingsManager');

function holder(): Record<symbol, AppManagerLike | null> {
  return globalThis as unknown as Record<symbol, AppManagerLike | null>;
}

/** Called by the layer at mount. Until then, and in unit tests, the environment is the only source. */
export function usePushSettingStorage(appManager: AppManagerLike): void {
  holder()[MANAGER_KEY] = appManager;
}

export function forgetPushSettingStorage(): void {
  holder()[MANAGER_KEY] = null;
}

function storage(): SettingStorageLike | null {
  return holder()[MANAGER_KEY]?.settingStorage ?? null;
}

export function isPushSettingKey(key: string): key is PushSettingKey {
  return (PUSH_SETTING_KEYS as readonly string[]).includes(key);
}

export function isSecretPushSetting(key: string): boolean {
  return SECRET_KEYS.has(key);
}

function fromEnv(key: PushSettingKey): string | undefined {
  const value = process.env[key];
  return value === undefined || value === '' ? undefined : value;
}

/** The value stored in the settings table, ignoring the environment. */
export function storedPushSetting(key: PushSettingKey): string | undefined {
  const value = storage()?.getSettingSlot(key)?.value;
  return value === undefined || value === null || value === '' ? undefined : String(value);
}

/** The value in force: the environment if it names this key, else what an administrator stored. */
export function pushSetting(key: PushSettingKey): string | undefined {
  const value = fromEnv(key);
  return value ?? storedPushSetting(key);
}

export type PushSettingSource = 'environment' | 'settings' | 'unset';

/**
 * Which source answered. The first thing to check when a change "did not apply": app-manager gives
 * the environment priority, so a key present in `.env` shadows anything stored.
 */
export function pushSettingSource(key: PushSettingKey): PushSettingSource {
  if (fromEnv(key) !== undefined) return 'environment';
  return storedPushSetting(key) === undefined ? 'unset' : 'settings';
}

/** True when a stored value exists but the environment is what the providers actually read. */
export function isShadowedByEnvironment(key: PushSettingKey): boolean {
  return fromEnv(key) !== undefined && storedPushSetting(key) !== undefined;
}

/**
 * What a value may be shown as. Secrets never come back — not their length, not a prefix that could
 * identify which key it is; only whether something is there at all.
 */
export function maskPushSetting(key: string, value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  return isSecretPushSetting(key) ? '••••••••' : value;
}
