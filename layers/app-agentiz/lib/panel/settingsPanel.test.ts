import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { DataTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../../models';
import { AgentProject } from '../../models/AgentProject';
import { AgentProjectMember } from '../../models/AgentProjectMember';
import { AgentRole } from '../../models/AgentRole';
import { AgentTaskSource } from '../../models/AgentTaskSource';
import { registerTaskManagerAdapter, unregisterTaskManagerAdapter } from '../taskManager';
import { ROLE_PRESETS } from '../access/tokens';
import {
  projectAgentRoles,
  projectGeneralView,
  projectMembersView,
  projectSourcesView,
} from './settingsPanel';

/**
 * What the four settings sections must keep true.
 *
 * The expensive half is the first one: two of these sections sit next to a credential, and both
 * send the row they hold it in straight into the page props. A mask applied per field would pass a
 * field-by-field assertion and still leak the day somebody adds a second secret key, so the whole
 * answer is serialized and searched for the value instead.
 *
 * The rest pins the things that are the *builder's* opinion rather than the model's: what «роль»
 * means when a group matches no rung of the ladder, what an unmounted adapter looks like, and that
 * a project which no longer exists answers `null` rather than an empty screen.
 */
describe('settingsPanel', () => {
  let sequelize: Sequelize;
  let project: AgentProject;

  const ADAPTER = {
    type: 'stub-tracker',
    title: 'Заглушка',
    description: 'Трекер для теста',
    configFields: [
      { key: 'url', title: 'Адрес', kind: 'text' as const },
      { key: 'token', title: 'Токен', kind: 'secret' as const },
    ],
  };

  beforeEach(async () => {
    sequelize = new Sequelize({
      dialect: 'sqlite', storage: ':memory:', logging: false,
      models: Object.values(agentizModels) as any[],
    });
    await sequelize.sync({ force: true });
    // The panel's own user/group tables are not ours; without them the builder must still answer,
    // which is exactly the shape a test database has and a fresh installation has too.
    project = await AgentProject.create({
      name: 'Биллинг',
      slug: 'billing',
      ownerId: 1,
      description: 'Оплаты',
      repoProvider: 'github',
      repoConfig: { owner: 'vibes', repo: 'billing' },
      secrets: { token: 'ЭТОТ-ТОКЕН-НЕ-ДОЛЖЕН-УЕХАТЬ' },
    } as any);
  });

  afterEach(async () => {
    unregisterTaskManagerAdapter(ADAPTER.type);
    await sequelize.close();
  });

  it('never lets the project token or a source secret onto a screen', async () => {
    registerTaskManagerAdapter(ADAPTER as any);
    await AgentTaskSource.create({
      projectId: project.id,
      name: 'Трекер',
      type: ADAPTER.type,
      config: { url: 'https://tracker.example' },
      secrets: { token: 'СЕКРЕТ-ИСТОЧНИКА' },
      isActive: true,
    } as any);

    const general = await projectGeneralView(project);
    const sources = await projectSourcesView(project.id);

    // Serialized whole, the way page props actually travel: a field added later has to fail this
    // too, which a per-field assertion would not catch.
    const wire = JSON.stringify({ general, sources });
    expect(wire).not.toContain('ЭТОТ-ТОКЕН-НЕ-ДОЛЖЕН-УЕХАТЬ');
    expect(wire).not.toContain('СЕКРЕТ-ИСТОЧНИКА');
    // The *fact* that a credential is stored is what a screen needs — never the value.
    expect(general.hasToken).toBe(true);
    expect(general.project.secrets).toEqual({ token: '********' });
    expect(sources.sources[0].secrets).toEqual({ token: '********' });
    // …and the non-secret half of the configuration is still readable, or the form shows nothing.
    expect(sources.sources[0].config).toEqual({ url: 'https://tracker.example' });
  });

  it('says a source is broken when its layer is not mounted, instead of showing it as idle', async () => {
    await AgentTaskSource.create({
      projectId: project.id, name: 'Чужой трекер', type: 'not-mounted', config: {}, secrets: {}, isActive: true,
    } as any);

    const { sources, managers } = await projectSourcesView(project.id);
    expect(sources[0].available).toBe(false);
    // The type is printed as stored rather than hidden: a layer that will be mounted tomorrow must
    // not make the row unreadable today.
    expect(sources[0].typeTitle).toBe('not-mounted');
    // The catalogue a *new* source is picked from holds only what is mounted right now.
    expect(managers.map((manager) => manager.type)).not.toContain('not-mounted');
  });

  it('answers null for a project that is gone, so the route can 404 instead of drawing an empty screen', async () => {
    expect(await projectMembersView('nope', null)).toBeNull();
  });

  it('names a role by its rung of the ladder and leaves an unmatched group as it is', async () => {
    const Group = sequelize.define('GroupAP', {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      name: { type: DataTypes.STRING },
      description: { type: DataTypes.STRING },
      tokens: { type: DataTypes.JSON },
    }, { tableName: 'groupap', timestamps: true });
    sequelize.define('UserAP', {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      login: { type: DataTypes.STRING },
      fullName: { type: DataTypes.STRING },
      email: { type: DataTypes.STRING },
    }, { tableName: 'userap', timestamps: true });
    await sequelize.sync();

    const maintainer = ROLE_PRESETS.find((preset) => preset.key === 'maintainer')!;
    const ladder: any = await Group.create({ name: maintainer.name, tokens: maintainer.tokens } as any);
    // A group whose token set matches no rung at all: `presetKey` is null and the screen calls it
    // «Особая роль» — which means "не совпало ни с одной ступенью", not "непонятно что".
    const odd: any = await Group.create({ name: 'Свои правила', tokens: ['agentiz-project-read'] } as any);
    const User: any = sequelize.model('UserAP');
    await User.create({ login: 'owner', fullName: 'Владелец' } as any);
    await User.create({ login: 'guest', fullName: 'Гость' } as any);

    await AgentProjectMember.create({ projectId: project.id, userId: 1, groupId: ladder.id } as any);
    await AgentProjectMember.create({ projectId: project.id, userId: 2, groupId: odd.id } as any);

    const view = (await projectMembersView(project.id, null))!;
    expect(view.items.map((row) => [row.user?.login, row.presetKey, row.isOwner]))
      .toEqual([['owner', 'maintainer', true], ['guest', null, false]]);
    // The owner is named from `ownerId`, which the access graph itself never reads — the membership
    // row above is what makes the project visible, and the screen refuses to remove it.
    expect(view.meta.owner?.login).toBe('owner');
    expect(view.meta.presets.map((preset) => preset.key))
      .toEqual(ROLE_PRESETS.map((preset) => preset.key));
    // A null actor holds nothing anywhere: the list is readable, the buttons are not drawn.
    expect(view.meta.canManage).toBe(false);
  });

  it('reads a project\'s agent roles without becoming a second editor of them', async () => {
    await AgentRole.create({
      projectId: project.id, key: 'fixer', title: 'Починить', model: 'claude-sonnet-5',
      config: { executor: 'openhands-acp', provider: 'claude', acpCommand: ['npx'] },
    } as any);
    await AgentRole.create({ projectId: project.id, key: 'checker', title: 'Проверить' } as any);

    expect(await projectAgentRoles(project.id)).toEqual([
      { id: expect.any(String), key: 'checker', title: 'Проверить', model: null, provider: null },
      { id: expect.any(String), key: 'fixer', title: 'Починить', model: 'claude-sonnet-5', provider: 'claude' },
    ]);
  });
});
