import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../models';
import { AgentProject } from '../models/AgentProject';
import { PipelineSpec } from '../models/PipelineSpec';
import { NOTIFY_POLICY_KEY, forgetNotifySettingStorage, useNotifySettingStorage } from '../lib/notifications/policySettings';
import { NotificationPolicyService } from './NotificationPolicyService';

/**
 * An AppManager double: the Setting model rows plus the in-memory slot, wired together the way
 * app-manager wires them (a row's save refreshes the slot — here done directly, standing in for
 * `Setting.afterSaveHook`).
 */
function appManagerDouble() {
  const slot: { key: string; type: 'json'; value?: unknown } = { key: NOTIFY_POLICY_KEY, type: 'json' };
  const rows = new Map<string, { key: string; value: unknown }>();
  const rowFor = (key: string) => {
    const backing = rows.get(key)!;
    return {
      key: backing.key,
      get value() { return backing.value; },
      async update(values: Record<string, unknown>) {
        backing.value = values.value;
        slot.value = values.value;
      },
      async destroy() { rows.delete(key); },
    };
  };
  return {
    slot,
    rows,
    manager: {
      sequelize: {
        models: {
          Setting: {
            async findOne({ where }: { where: { key: string } }) {
              return rows.has(where.key) ? rowFor(where.key) : null;
            },
            async create(values: { key: string; value: unknown }) {
              rows.set(values.key, { ...values });
              slot.value = values.value;
              return rowFor(values.key);
            },
          },
        },
      },
      settingStorage: {
        get: () => slot.value,
        getSettingSlot: (key: string) => (key === NOTIFY_POLICY_KEY ? slot : undefined),
      },
    },
  };
}

describe('NotificationPolicyService', () => {
  let sequelize: Sequelize;
  let projectId: string;
  let specId: string;
  let double: ReturnType<typeof appManagerDouble>;

  beforeAll(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, models: Object.values(agentizModels) as any[] });
  });

  afterAll(async () => sequelize.close());

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    delete process.env[NOTIFY_POLICY_KEY];
    double = appManagerDouble();
    useNotifySettingStorage(double.manager as any);
    NotificationPolicyService.use(double.manager as any);
    const project = await AgentProject.create({ name: 'Owned', slug: 'owned', ownerId: 1 } as any);
    const spec = await PipelineSpec.create({
      projectId: project.id,
      name: 'Release',
      spec: {
        stages: [{ order: 1, role: 'implement', agentRoleKey: 'developer', runtime: { mode: 'host' } }],
        finalAction: { type: 'none' },
      },
      isActive: true,
    } as any);
    projectId = project.id;
    specId = spec.id;
  });

  afterEach(() => {
    delete process.env[NOTIFY_POLICY_KEY];
    forgetNotifySettingStorage();
    NotificationPolicyService.forget();
  });

  it('stores a valid document and reads it back as the effective one', async () => {
    const result = await NotificationPolicyService.set({
      defaults: { 'run.succeeded': { push: 'off' } },
      projects: { [projectId]: { mute: true } },
      pipelines: { [specId]: { 'run.succeeded': { push: 'on' } } },
    });

    expect(result.pruned).toEqual([]);
    expect(result.source).toBe('settings');
    expect(result.document.projects).toHaveProperty(projectId);
    expect(NotificationPolicyService.describe().document.defaults).toEqual({ 'run.succeeded': { push: 'off' } });
  });

  it('rejects a document Ajv does not accept, naming the failure', async () => {
    await expect(NotificationPolicyService.set({ defaults: { 'run.succeeded': { push: 'loud' } } } as any))
      .rejects.toThrow(/does not match the schema/);
    expect(double.rows.size).toBe(0);
  });

  it('prunes entries whose project or pipeline no longer exists', async () => {
    const result = await NotificationPolicyService.set({
      projects: { [projectId]: { mute: true }, 'gone-project': { mute: true } },
      pipelines: { [specId]: { mute: true }, 'gone-spec': { mute: true } },
    });

    expect(result.pruned.sort()).toEqual(['pipelines.gone-spec', 'projects.gone-project']);
    expect(Object.keys(result.document.projects ?? {})).toEqual([projectId]);
    expect(Object.keys(result.document.pipelines ?? {})).toEqual([specId]);
  });

  it('reports a shadowed write as a warning instead of doing nothing visible', async () => {
    process.env[NOTIFY_POLICY_KEY] = JSON.stringify({ defaults: { 'run.failed': { push: 'off' } } });

    const result = await NotificationPolicyService.set({ defaults: { 'run.failed': { push: 'on' } } });

    expect(result.warnings.some((warning) => warning.includes('environment'))).toBe(true);
    expect(result.source).toBe('environment');
    // The effective document is still the environment's — that is exactly what the warning says.
    expect(result.document.defaults).toEqual({ 'run.failed': { push: 'off' } });
  });

  it('removes the stored document on set(null)', async () => {
    await NotificationPolicyService.set({ defaults: { 'run.failed': { push: 'off' } } });
    expect(NotificationPolicyService.describe().source).toBe('settings');

    await NotificationPolicyService.set(null);

    expect(NotificationPolicyService.describe().source).toBe('unset');
    expect(NotificationPolicyService.describe().document).toEqual({});
  });
});
