import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import {
  NOTIFY_POLICY_KEY,
  effectiveActivityPolicy,
  forgetNotifySettingStorage,
  isNotifyPolicyShadowedByEnvironment,
  notifyPolicyJsonSchema,
  notifyPolicySource,
  useNotifySettingStorage,
  type NotifyPolicyDocument,
} from './policySettings';
import { activityTypes } from './activityTypes';

/** A fake settingStorage holding one slot, the way app-manager keeps it in memory. */
function storageWith(document: NotifyPolicyDocument | undefined) {
  const slot: { key: string; type: 'json'; value?: unknown } = { key: NOTIFY_POLICY_KEY, type: 'json' };
  if (document !== undefined) slot.value = document;
  return {
    settingStorage: {
      get: () => slot.value,
      getSettingSlot: (key: string) => (key === NOTIFY_POLICY_KEY ? slot : undefined),
    },
    slot,
  };
}

describe('policySettings', () => {
  beforeEach(() => {
    delete process.env[NOTIFY_POLICY_KEY];
    forgetNotifySettingStorage();
  });

  afterEach(() => {
    delete process.env[NOTIFY_POLICY_KEY];
    forgetNotifySettingStorage();
  });

  it('falls back to the built-in defaults with nothing configured anywhere', () => {
    expect(effectiveActivityPolicy('run.succeeded', 'p1')).toEqual({ push: 'silent', dashboard: 'on' });
    expect(effectiveActivityPolicy('run.cancelled', 'p1')).toEqual({ push: 'off', dashboard: 'off' });
    expect(effectiveActivityPolicy('interaction.created', 'p1')).toEqual({ push: 'on', dashboard: 'on' });
    expect(notifyPolicySource()).toBe('unset');
  });

  it('resolves scopes from specific to general, per channel', () => {
    useNotifySettingStorage(storageWith({
      defaults: { 'run.failed': { push: 'silent', dashboard: 'off' } },
      projects: { p1: { 'run.failed': { push: 'off' } } },
      pipelines: { spec1: { 'run.failed': { push: 'on' } } },
    }));

    // Project entry set only push; dashboard falls through to defaults.
    expect(effectiveActivityPolicy('run.failed', 'p1')).toEqual({ push: 'off', dashboard: 'off' });
    // Pipeline entry wins over the project one for the channel it names.
    expect(effectiveActivityPolicy('run.failed', 'p1', 'spec1')).toEqual({ push: 'on', dashboard: 'off' });
    // Unrelated project only sees defaults.
    expect(effectiveActivityPolicy('run.failed', 'p2')).toEqual({ push: 'silent', dashboard: 'off' });
    expect(notifyPolicySource()).toBe('settings');
  });

  it('applies mute below more specific entries — the "все выключено, кроме релизного" case', () => {
    useNotifySettingStorage(storageWith({
      projects: { p1: { mute: true } },
      pipelines: { release: { 'run.succeeded': { push: 'on' } } },
    }));

    expect(effectiveActivityPolicy('run.succeeded', 'p1')).toEqual({ push: 'off', dashboard: 'off' });
    expect(effectiveActivityPolicy('run.succeeded', 'p1', 'hourly')).toEqual({ push: 'off', dashboard: 'off' });
    expect(effectiveActivityPolicy('run.succeeded', 'p1', 'release')).toEqual({ push: 'on', dashboard: 'off' });
    // An explicit project entry still beats the project's own mute.
    useNotifySettingStorage(storageWith({ projects: { p1: { mute: true, 'run.failed': { push: 'on' } } } }));
    expect(effectiveActivityPolicy('run.failed', 'p1').push).toBe('on');
  });

  it('lets the environment shadow the stored document entirely', () => {
    useNotifySettingStorage(storageWith({ defaults: { 'run.failed': { push: 'off' } } }));
    process.env[NOTIFY_POLICY_KEY] = JSON.stringify({ defaults: { 'run.failed': { push: 'silent' } } });

    expect(effectiveActivityPolicy('run.failed', 'p1').push).toBe('silent');
    expect(notifyPolicySource()).toBe('environment');
    expect(isNotifyPolicyShadowedByEnvironment()).toBe(true);
  });

  it('ignores unparseable environment JSON instead of dying', () => {
    process.env[NOTIFY_POLICY_KEY] = '{not json';
    expect(effectiveActivityPolicy('run.failed', 'p1').push).toBe('on');
    expect(notifyPolicySource()).toBe('unset');
  });

  it('generates a schema that accepts the documented example and rejects garbage', async () => {
    const Ajv = (await import('ajv')).default;
    const validate = new Ajv().compile(notifyPolicyJsonSchema());

    expect(validate({
      defaults: { 'run.succeeded': { push: 'off' } },
      projects: { p1: { mute: true }, p2: { 'interaction.created': { push: 'off' }, 'run.failed': { push: 'silent' } } },
      pipelines: { hourly: { mute: true }, release: { 'run.succeeded': { push: 'on' } } },
    })).toBe(true);

    expect(validate({ defaults: { 'run.succeeded': { push: 'loud' } } })).toBe(false);
    expect(validate({ defaults: { 'not.a.type': { push: 'on' } } })).toBe(false);
    expect(validate({ somethingElse: true })).toBe(false);
    // Every catalogued type has to be addressable in the schema.
    for (const def of activityTypes()) {
      expect(validate({ defaults: { [def.type]: { push: 'off' } } })).toBe(true);
    }
  });
});
