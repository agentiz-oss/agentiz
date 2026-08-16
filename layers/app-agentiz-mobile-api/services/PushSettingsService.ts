import { existsSync } from 'fs';
import {
  isPushSettingKey,
  isSecretPushSetting,
  isShadowedByEnvironment,
  maskPushSetting,
  PUSH_SETTING_KEYS,
  pushSetting,
  pushSettingSource,
  storedPushSetting,
  type PushSettingKey,
  type PushSettingSource,
} from '../lib/push/settings';
import { pushProviders, pushProviderSummary, resetPushProviders } from '../lib/push/providers';

/**
 * Installing and inspecting push credentials at runtime.
 *
 * The point is that a deployment can be given a Firebase service account or an APNs key — or moved
 * between `firebase` and `gateway` — without editing `.env` and restarting, which on this
 * installation means going through MCP rather than through a shell.
 *
 * The values live in app-manager's `settings` table, through the slots this layer declares
 * (`lib/push/settings.ts`); this service is the validation, the masking and the cache reset around
 * them. Three rules make that safe to expose:
 *
 * - **Values never come back.** `describe()` reports where a setting came from and whether it is
 *   present; a credential is write-only from the moment it arrives.
 * - **What cannot work is refused, not stored.** A service account that is not a service account, a
 *   gateway URL that is not a URL, `PUSH_PROVIDER=carrier-pigeon` — rejected with the reason,
 *   because the alternative is a silent failure at 3am inside the worker's request.
 * - **A shadowed write is reported, not silently lost.** app-manager gives `process.env` priority
 *   over a stored setting, so storing a key that `.env` also names changes nothing until that
 *   variable goes away. That comes back as a warning on the very call that stored it.
 */

export interface PushSettingView {
  key: PushSettingKey;
  /** `environment` (from `.env`, and it wins), `settings` (stored here), or `unset`. */
  source: PushSettingSource;
  /** The value in force, or `••••••••` for a credential, or null when nothing is set. */
  value: string | null;
  secret: boolean;
  /** True when something is stored but `.env` overrides it — the reason a change "did nothing". */
  shadowedByEnvironment?: boolean;
}

export interface PushSettingsSummary {
  provider: string;
  providers: { fcm: { name: string; configured: boolean } };
  pushEnabled: boolean;
  settings: PushSettingView[];
  /** Configurations that are accepted but cannot deliver — a half-filled APNs set, say. */
  warnings: string[];
}

/** The app-manager Setting row, addressed by model name so no deep import into the package is needed. */
interface SettingRow {
  key: string;
  value: unknown;
  update(values: Record<string, unknown>): Promise<unknown>;
  destroy(): Promise<unknown>;
}

interface SettingModel {
  findOne(options: { where: { key: string } }): Promise<SettingRow | null>;
  create(values: { key: string; value: unknown }): Promise<SettingRow>;
}

interface AppManagerLike {
  sequelize?: { models?: Record<string, unknown> };
}

// Set at mount, read when something is written. Not held by the providers: they only ever read, and
// reading goes through settingStorage.
const MANAGER_KEY = Symbol.for('agentiz.push.settingsWriter');

function holder(): Record<symbol, AppManagerLike | null> {
  return globalThis as unknown as Record<symbol, AppManagerLike | null>;
}

export class PushSettingsService {
  /** Called by the layer at mount, with the same AppManager the settings collection was processed by. */
  static use(appManager: AppManagerLike): void {
    holder()[MANAGER_KEY] = appManager;
    // Slots were filled from the database while the collection was processed, before this runs; the
    // providers may already have been built against the environment alone.
    resetPushProviders();
  }

  static forget(): void {
    holder()[MANAGER_KEY] = null;
  }

  private static model(): SettingModel {
    const model = holder()[MANAGER_KEY]?.sequelize?.models?.Setting as SettingModel | undefined;
    if (!model) {
      throw new Error('settings storage is unavailable: app-agentiz-mobile-api is not mounted');
    }
    return model;
  }

  /**
   * Writes settings and makes them effective immediately.
   *
   * `null` removes a setting, which falls back to the environment variable of the same name rather
   * than to nothing — deleting a value is "stop overriding", not "turn push off".
   */
  static async set(values: Record<string, string | null>, _updatedBy?: string): Promise<PushSettingsSummary> {
    const entries = Object.entries(values);
    if (entries.length === 0) throw new Error('nothing to set: pass at least one setting');

    const unknown = entries.map(([key]) => key).filter((key) => !isPushSettingKey(key));
    if (unknown.length > 0) {
      throw new Error(`unknown push setting(s): ${unknown.join(', ')}. Known: ${PUSH_SETTING_KEYS.join(', ')}`);
    }

    // Validate everything before writing anything: a half-applied credential change is worse than a
    // rejected one, because the half that applied is the half nobody will remember.
    const prepared: { key: PushSettingKey; value: string | null }[] = [];
    for (const [key, raw] of entries as [PushSettingKey, string | null][]) {
      if (raw === null) {
        prepared.push({ key, value: null });
        continue;
      }
      const value = String(raw).trim();
      if (!value) throw new Error(`${key}: empty value. Pass null to remove the setting instead.`);
      prepared.push({ key, value: validate(key, value) });
    }

    const model = PushSettingsService.model();
    for (const { key, value } of prepared) {
      const existing = await model.findOne({ where: { key } });
      if (value === null) {
        // The slot keeps its value in memory after the row goes, so it is cleared explicitly.
        if (existing) await existing.destroy();
        clearSlotValue(key);
      } else if (existing) {
        // Through the instance, not the model: app-manager's hooks are what write the value back
        // into settingStorage, and a bulk update would skip them.
        await existing.update({ value });
      } else {
        await model.create({ key, value });
      }
    }

    // A provider caches its credentials and its HTTP/2 session; without this the next notification
    // would still go out with the old ones.
    resetPushProviders();
    return PushSettingsService.describe();
  }

  /** What is in force right now, with the secrets masked. Safe to hand to any authenticated caller. */
  static describe(): PushSettingsSummary {
    const resolved = pushProviders();
    return {
      provider: pushProviderSummary(),
      providers: {
        fcm: { name: resolved.fcm.name, configured: resolved.fcm.configured() },
      },
      pushEnabled: resolved.fcm.configured(),
      settings: PUSH_SETTING_KEYS.map((key) => ({
        key,
        source: pushSettingSource(key),
        value: maskPushSetting(key, pushSetting(key)),
        secret: isSecretPushSetting(key),
        ...(isShadowedByEnvironment(key) ? { shadowedByEnvironment: true } : {}),
      })),
      warnings: warningsFor(),
    };
  }
}

/** Drops the in-memory value of a removed setting, which app-manager leaves in place on destroy. */
function clearSlotValue(key: PushSettingKey): void {
  const manager = holder()[MANAGER_KEY] as { settingStorage?: { getSettingSlot(key: string): any } } | null;
  const slot = manager?.settingStorage?.getSettingSlot(key);
  if (slot) delete slot.value;
}

/**
 * Per-setting checks, run before the value is stored.
 *
 * Deliberately shallow: this proves the value is of the right *kind*, not that Google and Apple
 * accept it. A revoked key is indistinguishable from a good one until something is sent, and the
 * failure reasons that come back cover that half.
 */
function validate(key: PushSettingKey, value: string): string {
  switch (key) {
    case 'PUSH_PROVIDER': {
      const provider = value.toLowerCase();
      if (provider !== 'firebase' && provider !== 'gateway') {
        throw new Error(`PUSH_PROVIDER must be "firebase" or "gateway", received "${value}"`);
      }
      return provider;
    }
    case 'AGENTIZ_FCM_SERVICE_ACCOUNT': {
      // Both forms the provider accepts: the JSON itself, or a path to it.
      if (value.trimStart().startsWith('{')) {
        let parsed: any;
        try {
          parsed = JSON.parse(value);
        } catch {
          throw new Error('AGENTIZ_FCM_SERVICE_ACCOUNT: not valid JSON');
        }
        const missing = ['project_id', 'client_email', 'private_key'].filter((field) => !parsed?.[field]);
        if (missing.length > 0) {
          throw new Error(`AGENTIZ_FCM_SERVICE_ACCOUNT: service account is missing ${missing.join(', ')}`);
        }
        return value;
      }
      if (!existsSync(value)) throw new Error(`AGENTIZ_FCM_SERVICE_ACCOUNT: no such file "${value}"`);
      return value;
    }
    case 'PUSH_GATEWAY_URL': {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new Error(`PUSH_GATEWAY_URL: "${value}" is not a URL`);
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('PUSH_GATEWAY_URL must be http or https');
      }
      return value.replace(/\/+$/, '');
    }
    case 'PUSH_GATEWAY_TIMEOUT_MS': {
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms < 100 || ms > 60_000) {
        throw new Error('PUSH_GATEWAY_TIMEOUT_MS must be a number between 100 and 60000');
      }
      return String(Math.round(ms));
    }
    default:
      return value;
  }
}

/** Combinations that are stored happily but deliver nothing — worth saying out loud, not refusing. */
function warningsFor(): string[] {
  const warnings: string[] = [];

  for (const key of PUSH_SETTING_KEYS) {
    if (isShadowedByEnvironment(key)) {
      warnings.push(`${key} is set here but ${key} in the environment overrides it; remove it from .env for this value to take effect`);
    }
  }

  const provider = (pushSetting('PUSH_PROVIDER') ?? 'firebase').toLowerCase();
  if (provider === 'gateway') {
    if (!pushSetting('PUSH_GATEWAY_URL')) warnings.push('PUSH_PROVIDER=gateway but PUSH_GATEWAY_URL is not set');
    if (!pushSetting('PUSH_GATEWAY_API_KEY')) warnings.push('PUSH_PROVIDER=gateway but PUSH_GATEWAY_API_KEY is not set');
  } else if (!pushSetting('AGENTIZ_FCM_SERVICE_ACCOUNT')) {
    warnings.push('PUSH_PROVIDER=firebase but AGENTIZ_FCM_SERVICE_ACCOUNT is not set; push is off');
  }

  return warnings;
}

/** Re-exported so callers do not have to reach into lib/push for the one thing they may need. */
export { storedPushSetting };
