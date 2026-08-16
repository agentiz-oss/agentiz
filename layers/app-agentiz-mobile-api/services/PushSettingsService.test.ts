import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Sequelize } from 'sequelize-typescript';
import { SettingStorage } from '@nodeknit/app-manager/dist/lib/SettingStorage.js';
import { DataTypes, Model } from 'sequelize';
import {
  forgetPushSettingStorage,
  PUSH_SETTING_SLOTS,
  pushSetting,
  pushSettingSlots,
  usePushSettingStorage,
} from '../lib/push/settings';
import { pushProviders, resetPushProviders } from '../lib/push/providers';
import { PushSettingsService } from './PushSettingsService';

/**
 * Installing a push credential without a deploy. Three properties matter more than the mechanics:
 * a value that cannot work is refused rather than stored, a value that is stored never comes back
 * out, and a value the environment overrides is *reported* — app-manager gives `.env` priority, so
 * a stored setting that changes nothing is the failure mode to make visible.
 *
 * The storage is app-manager's own (SettingStorage plus the `settings` table), not a stand-in: the
 * priority rule under test is theirs, and a stub would be free to get it wrong.
 */
describe('PushSettingsService', () => {
  let sequelize: Sequelize;
  let appManager: any;
  const env = { ...process.env };

  /** app-manager's Setting model, minus the hooks that need a whole AppManager to fire. */
  class Setting extends Model {}

  beforeAll(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
    Setting.init(
      { key: { type: DataTypes.STRING, primaryKey: true }, value: { type: DataTypes.JSON } },
      { sequelize, modelName: 'Setting', tableName: 'settings', timestamps: false },
    );
    await sequelize.sync({ force: true });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  beforeEach(async () => {
    await Setting.destroy({ where: {} });
    // A fresh storage per test, with this layer's slots registered exactly as the collection does.
    const settingStorage = new SettingStorage();
    for (const slotClass of pushSettingSlots) {
      const slot = new slotClass();
      settingStorage.setSettingSlot(slot.key, slot as any);
    }
    appManager = { settingStorage, sequelize };
    // The real Setting writes back into storage from a model hook; here the hook is the test's job.
    Setting.addHook('afterSave', (instance: any) => settingStorage.set(instance.key, instance.value));

    usePushSettingStorage(appManager);
    PushSettingsService.use(appManager);
    process.env = { ...env };
    for (const key of Object.keys(PUSH_SETTING_SLOTS)) delete process.env[key];
    resetPushProviders();
  });

  afterEach(() => {
    process.env = { ...env };
    forgetPushSettingStorage();
    PushSettingsService.forget();
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

  it('stores the value in app-manager settings, not in a table of our own', async () => {
    await PushSettingsService.set({ PUSH_GATEWAY_URL: 'https://push.example.com' });

    const row = await Setting.findOne({ where: { key: 'PUSH_GATEWAY_URL' } });
    expect((row as any)?.value).toBe('https://push.example.com');
    expect(appManager.settingStorage.getSettingSlot('PUSH_GATEWAY_URL').value).toBe('https://push.example.com');
  });

  it('never gives a stored credential back', async () => {
    await PushSettingsService.set({ PUSH_GATEWAY_API_KEY: 'push_sk_live_secret' });

    const view = PushSettingsService.describe();
    const key = view.settings.find((setting) => setting.key === 'PUSH_GATEWAY_API_KEY');

    expect(key).toMatchObject({ source: 'settings', secret: true });
    expect(key?.value).not.toContain('secret');
    expect(JSON.stringify(view)).not.toContain('push_sk_live_secret');
  });

  it('reports where each value came from', async () => {
    process.env.PUSH_GATEWAY_URL = 'https://from-env.example.com';
    await PushSettingsService.set({ PUSH_GATEWAY_TIMEOUT_MS: '5000' });

    const by = Object.fromEntries(PushSettingsService.describe().settings.map((s) => [s.key, s]));

    expect(by.PUSH_GATEWAY_TIMEOUT_MS.source).toBe('settings');
    expect(by.PUSH_GATEWAY_URL).toMatchObject({ source: 'environment', value: 'https://from-env.example.com' });
    expect(by.PUSH_GATEWAY_API_KEY.source).toBe('unset');
  });

  it('says so when the environment shadows what was just stored', async () => {
    process.env.PUSH_PROVIDER = 'firebase';

    const summary = await PushSettingsService.set({ PUSH_PROVIDER: 'gateway' });

    // Stored, and still not in force: app-manager reads process.env first. Silently doing nothing
    // here is the difference between a puzzling afternoon and a one-line answer.
    expect(pushSetting('PUSH_PROVIDER')).toBe('firebase');
    expect(summary.settings.find((s) => s.key === 'PUSH_PROVIDER')).toMatchObject({
      source: 'environment',
      shadowedByEnvironment: true,
    });
    expect(summary.warnings.join(' ')).toMatch(/PUSH_PROVIDER in the environment overrides it/);
  });

  it('removing a setting falls back to the environment, it does not turn push off', async () => {
    process.env.PUSH_PROVIDER = 'firebase';
    await PushSettingsService.set({ PUSH_PROVIDER: 'gateway' });

    await PushSettingsService.set({ PUSH_PROVIDER: null });

    expect(pushSetting('PUSH_PROVIDER')).toBe('firebase');
    expect(await Setting.count()).toBe(0);

    delete process.env.PUSH_PROVIDER;
    expect(pushSetting('PUSH_PROVIDER')).toBeUndefined();
  });

  describe('refuses what cannot work, before storing it', () => {
    const rejected: [string, string, RegExp][] = [
      ['PUSH_PROVIDER', 'carrier-pigeon', /firebase.*gateway/],
      ['PUSH_GATEWAY_URL', 'push.example.com', /not a URL/],
      ['PUSH_GATEWAY_TIMEOUT_MS', '5', /between 100 and 60000/],
      ['AGENTIZ_FCM_SERVICE_ACCOUNT', '{"project_id":"p"}', /missing client_email, private_key/],
      ['AGENTIZ_FCM_SERVICE_ACCOUNT', '{not json', /not valid JSON/],
      ['AGENTIZ_FCM_SERVICE_ACCOUNT', '/nowhere/service-account.json', /no such file/],
    ];

    for (const [key, value, message] of rejected) {
      it(`${key}=${value}`, async () => {
        await expect(PushSettingsService.set({ [key]: value })).rejects.toThrow(message);
        expect(await Setting.count()).toBe(0);
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
      expect(await Setting.count()).toBe(0);
      expect(pushSetting('PUSH_PROVIDER')).toBeUndefined();
    });
  });

  describe('warnings', () => {
    it('names a gateway selected without somewhere to send', async () => {
      await PushSettingsService.set({ PUSH_PROVIDER: 'gateway' });

      expect(PushSettingsService.describe().warnings.join(' ')).toMatch(/PUSH_GATEWAY_URL is not set/);
    });

    it('names firebase selected with no service account, which is the silent one', async () => {
      await PushSettingsService.set({ PUSH_PROVIDER: 'firebase' });

      expect(PushSettingsService.describe().warnings.join(' ')).toMatch(/AGENTIZ_FCM_SERVICE_ACCOUNT is not set/);
    });
  });

  it('falls back to the environment alone when the layer is not mounted', async () => {
    forgetPushSettingStorage();
    PushSettingsService.forget();
    process.env.PUSH_PROVIDER = 'gateway';

    expect(pushSetting('PUSH_PROVIDER')).toBe('gateway');
    await expect(PushSettingsService.set({ PUSH_PROVIDER: 'firebase' })).rejects.toThrow(/not mounted/);
  });
});
