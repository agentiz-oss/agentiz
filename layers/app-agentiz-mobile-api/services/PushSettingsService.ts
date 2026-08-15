import { existsSync } from 'fs';
import { MobilePushSetting } from '../models/MobilePushSetting';
import {
  isPushSettingKey,
  isSecretPushSetting,
  maskPushSetting,
  PUSH_SETTING_KEYS,
  pushSetting,
  pushSettingSource,
  replacePushSettingOverlay,
  type PushSettingKey,
} from '../lib/push/settings';
import { pushProviders, pushProviderSummary, resetPushProviders } from '../lib/push/providers';

/**
 * Installing and inspecting push credentials at runtime.
 *
 * The point of the table behind this is that a deployment can be given a Firebase service account
 * or an APNs key — or moved between `firebase` and `gateway` — without editing `.env` and
 * restarting, which on this installation means going through MCP rather than through a shell.
 *
 * Two rules make that safe to expose:
 *
 * - **Values never come back.** `describe()` reports where a setting came from and whether it is
 *   present; the secrets themselves are write-only from the moment they arrive.
 * - **What cannot work is refused, not stored.** A service account that is not a service account,
 *   a gateway URL that is not a URL, `PUSH_PROVIDER=carrier-pigeon` — all rejected with the reason,
 *   because the alternative is a silent failure at 3am inside the worker's request.
 */

export interface PushSettingView {
  key: PushSettingKey;
  /** `database` (set here), `environment` (from `.env`), or `unset`. */
  source: ReturnType<typeof pushSettingSource>;
  /** The value, or `••••••••` for a credential, or null when nothing is set. */
  value: string | null;
  secret: boolean;
}

export interface PushSettingsSummary {
  provider: string;
  providers: { fcm: { name: string; configured: boolean }; apns: { configured: boolean } };
  pushEnabled: boolean;
  settings: PushSettingView[];
  /** Configurations that are accepted but cannot deliver — a half-filled APNs set, say. */
  warnings: string[];
}

export class PushSettingsService {
  /**
   * Loads the stored settings into the in-memory overlay the providers read.
   *
   * Called once on mount. A failure here must not stop the layer: push is optional, and a table
   * that is not there yet (first boot, migration pending) simply means the environment is in charge.
   */
  static async load(): Promise<void> {
    try {
      const rows = await MobilePushSetting.findAll();
      replacePushSettingOverlay(Object.fromEntries(rows.map((row) => [row.key, row.value])));
      resetPushProviders();
    } catch (error) {
      console.warn(
        '[app-agentiz-mobile-api] push settings could not be loaded; using the environment only:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * Writes settings and makes them effective immediately.
   *
   * `null` removes a setting, which falls back to the environment variable of the same name rather
   * than to nothing — deleting a row is "stop overriding", not "turn push off".
   */
  static async set(values: Record<string, string | null>, updatedBy?: string): Promise<PushSettingsSummary> {
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

    for (const { key, value } of prepared) {
      if (value === null) {
        await MobilePushSetting.destroy({ where: { key } });
      } else {
        const existing = await MobilePushSetting.findByPk(key);
        if (existing) await existing.update({ value, updatedBy: updatedBy ?? null });
        else await MobilePushSetting.create({ key, value, updatedBy: updatedBy ?? null } as any);
      }
    }

    await PushSettingsService.load();
    return PushSettingsService.describe();
  }

  /** What is in force right now, with the secrets masked. Safe to hand to any authenticated caller. */
  static describe(): PushSettingsSummary {
    const resolved = pushProviders();
    return {
      provider: pushProviderSummary(),
      providers: {
        fcm: { name: resolved.fcm.name, configured: resolved.fcm.configured() },
        apns: { configured: resolved.apns.configured() },
      },
      pushEnabled: resolved.fcm.configured() || resolved.apns.configured(),
      settings: PUSH_SETTING_KEYS.map((key) => ({
        key,
        source: pushSettingSource(key),
        value: maskPushSetting(key, pushSetting(key)),
        secret: isSecretPushSetting(key),
      })),
      warnings: warningsFor(),
    };
  }
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
    case 'AGENTIZ_APNS_KEY': {
      if (value.includes('BEGIN PRIVATE KEY')) return value;
      if (!existsSync(value)) {
        throw new Error('AGENTIZ_APNS_KEY: expected the contents of the .p8 file, or a path to it');
      }
      return value;
    }
    case 'AGENTIZ_APNS_KEY_ID':
    case 'AGENTIZ_APNS_TEAM_ID': {
      // Apple issues 10-character identifiers; anything else is a copy-paste accident that would
      // otherwise surface as an unexplained 403 from APNs.
      if (!/^[A-Z0-9]{10}$/i.test(value)) throw new Error(`${key}: expected a 10-character Apple identifier`);
      return value.toUpperCase();
    }
    case 'AGENTIZ_APNS_ENV': {
      const env = value.toLowerCase();
      if (env !== 'production' && env !== 'sandbox') {
        throw new Error('AGENTIZ_APNS_ENV must be "production" or "sandbox"');
      }
      return env;
    }
    default:
      return value;
  }
}

/** Combinations that are stored happily but deliver nothing — worth saying out loud, not refusing. */
function warningsFor(): string[] {
  const warnings: string[] = [];
  const provider = (pushSetting('PUSH_PROVIDER') ?? 'firebase').toLowerCase();

  if (provider === 'gateway') {
    if (!pushSetting('PUSH_GATEWAY_URL')) warnings.push('PUSH_PROVIDER=gateway but PUSH_GATEWAY_URL is not set');
    if (!pushSetting('PUSH_GATEWAY_API_KEY')) warnings.push('PUSH_PROVIDER=gateway but PUSH_GATEWAY_API_KEY is not set');
  } else if (!pushSetting('AGENTIZ_FCM_SERVICE_ACCOUNT')) {
    warnings.push('PUSH_PROVIDER=firebase but AGENTIZ_FCM_SERVICE_ACCOUNT is not set; Android push is off');
  }

  const apns = ['AGENTIZ_APNS_KEY', 'AGENTIZ_APNS_KEY_ID', 'AGENTIZ_APNS_TEAM_ID', 'AGENTIZ_APNS_BUNDLE_ID'] as const;
  const present = apns.filter((key) => pushSetting(key));
  if (present.length > 0 && present.length < apns.length) {
    warnings.push(`APNs is half-configured; iOS push stays off until all four are set (missing: ${
      apns.filter((key) => !pushSetting(key)).join(', ')})`);
  }
  if (present.length === apns.length && (pushSetting('AGENTIZ_APNS_ENV') ?? 'production') === 'production') {
    warnings.push('AGENTIZ_APNS_ENV=production: tokens from a development (Xcode) build will be rejected as BadDeviceToken');
  }
  return warnings;
}
