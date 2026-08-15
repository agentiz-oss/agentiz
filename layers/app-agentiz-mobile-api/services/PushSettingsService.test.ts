import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));

import { Sequelize } from 'sequelize-typescript';
import { MobilePushSetting } from '../models/MobilePushSetting';
import { clearPushSettingOverlay, pushSetting } from '../lib/push/settings';
import { pushProviders, resetPushProviders } from '../lib/push/providers';
import { PushSettingsService } from './PushSettingsService';

/**
 * Installing a push credential without a deploy. Two properties matter more than the mechanics:
 * a value that cannot work is refused rather than stored, and a value that is stored never comes
 * back out — the table holds keys that can notify every install of the app.
 */
describe('PushSettingsService', () => {
  let sequelize: Sequelize;
  const env = { ...process.env };

  beforeAll(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, models: [MobilePushSetting] });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    clearPushSettingOverlay();
    resetPushProviders();
    process.env = { ...env };
    delete process.env.PUSH_PROVIDER;
    delete process.env.PUSH_GATEWAY_URL;
    delete process.env.PUSH_GATEWAY_API_KEY;
    delete process.env.AGENTIZ_FCM_SERVICE_ACCOUNT;
  });

  afterEach(() => {
    process.env = { ...env };
    clearPushSettingOverlay();
    resetPushProviders();
  });

  it('moves the sender to the gateway without a restart', async () => {
    expect(pushProviders().fcm.name).toBe('firebase');

    await PushSettingsService.set({
      PUSH_PROVIDER: 'gateway',
      PUSH_GATEWAY_URL: 'https://push.example.com/',
      PUSH_GATEWAY_API_KEY: 'push_sk_live',
    });

    // The provider pair is rebuilt, not merely the row written: the next notification has to use it.
    expect(pushProviders().fcm.name).toBe('gateway');
    expect(pushProviders().fcm.configured()).toBe(true);
    // Trailing slash normalised at the door, so the request path cannot end up with a double slash.
    expect(pushSetting('PUSH_GATEWAY_URL')).toBe('https://push.example.com');
  });

  it('never gives a stored credential back', async () => {
    await PushSettingsService.set({ PUSH_GATEWAY_API_KEY: 'push_sk_live_secret' });

    const view = PushSettingsService.describe();
    const key = view.settings.find((setting) => setting.key === 'PUSH_GATEWAY_API_KEY');

    expect(key).toMatchObject({ source: 'database', secret: true });
    expect(key?.value).not.toContain('secret');
    expect(JSON.stringify(view)).not.toContain('push_sk_live_secret');
  });

  it('reports where each value came from', async () => {
    process.env.AGENTIZ_APNS_BUNDLE_ID = 'cx.m42.agentoz';
    await PushSettingsService.set({ AGENTIZ_APNS_TEAM_ID: '5K5GDFV386' });

    const by = Object.fromEntries(PushSettingsService.describe().settings.map((s) => [s.key, s]));

    expect(by.AGENTIZ_APNS_TEAM_ID.source).toBe('database');
    expect(by.AGENTIZ_APNS_BUNDLE_ID).toMatchObject({ source: 'environment', value: 'cx.m42.agentoz' });
    expect(by.AGENTIZ_APNS_KEY_ID.source).toBe('unset');
  });

  it('removing a setting falls back to the environment, it does not turn push off', async () => {
    process.env.PUSH_PROVIDER = 'firebase';
    await PushSettingsService.set({ PUSH_PROVIDER: 'gateway' });
    expect(pushSetting('PUSH_PROVIDER')).toBe('gateway');

    await PushSettingsService.set({ PUSH_PROVIDER: null });

    expect(pushSetting('PUSH_PROVIDER')).toBe('firebase');
    expect(await MobilePushSetting.count()).toBe(0);
  });

  describe('refuses what cannot work, before storing it', () => {
    const rejected: [string, string, RegExp][] = [
      ['PUSH_PROVIDER', 'carrier-pigeon', /firebase.*gateway/],
      ['PUSH_GATEWAY_URL', 'push.example.com', /not a URL/],
      ['PUSH_GATEWAY_TIMEOUT_MS', '5', /between 100 and 60000/],
      ['AGENTIZ_FCM_SERVICE_ACCOUNT', '{"project_id":"p"}', /missing client_email, private_key/],
      ['AGENTIZ_FCM_SERVICE_ACCOUNT', '{not json', /not valid JSON/],
      ['AGENTIZ_APNS_KEY_ID', 'SHORT', /10-character/],
      ['AGENTIZ_APNS_ENV', 'staging', /production.*sandbox/],
      ['AGENTIZ_APNS_KEY', '/nowhere/AuthKey.p8', /contents of the .p8/],
    ];

    for (const [key, value, message] of rejected) {
      it(`${key}=${value}`, async () => {
        await expect(PushSettingsService.set({ [key]: value })).rejects.toThrow(message);
        expect(await MobilePushSetting.count()).toBe(0);
      });
    }

    it('rejects an unknown key rather than storing a typo nothing will ever read', async () => {
      await expect(PushSettingsService.set({ PUSH_PROVIDR: 'gateway' })).rejects.toThrow(/unknown push setting/);
    });

    it('applies nothing when one value in the batch is bad', async () => {
      await expect(PushSettingsService.set({
        PUSH_PROVIDER: 'gateway',
        PUSH_GATEWAY_URL: 'not-a-url',
      })).rejects.toThrow(/not a URL/);

      // A half-applied credential change is worse than a rejected one.
      expect(await MobilePushSetting.count()).toBe(0);
      expect(pushSetting('PUSH_PROVIDER')).toBeUndefined();
    });
  });

  describe('warnings', () => {
    it('names a gateway selected without somewhere to send', async () => {
      await PushSettingsService.set({ PUSH_PROVIDER: 'gateway' });

      expect(PushSettingsService.describe().warnings.join(' ')).toMatch(/PUSH_GATEWAY_URL is not set/);
    });

    it('names a half-configured APNs set, which is the silent one', async () => {
      await PushSettingsService.set({ AGENTIZ_APNS_KEY_ID: 'ABC123DEFG', AGENTIZ_APNS_TEAM_ID: '5K5GDFV386' });

      expect(PushSettingsService.describe().warnings.join(' ')).toMatch(/half-configured.*AGENTIZ_APNS_KEY/s);
    });
  });

  it('survives the table not being there yet', async () => {
    await sequelize.getQueryInterface().dropTable('agentiz_mobile_push_settings');

    // First boot with the migration still pending: the environment stays in charge, nothing throws.
    await expect(PushSettingsService.load()).resolves.toBeUndefined();
  });
});
