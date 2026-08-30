import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { DataTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../../models';
import { AgentProject } from '../../models/AgentProject';
import { AgentProjectMember } from '../../models/AgentProjectMember';
import { forgetOwnerRoleGroup, installAgentizAccessRoles } from './roleSeed';
import { projectIdsForUser } from './projectAccess';
import { ownerRolePreset, seededGroups } from './tokens';

/**
 * The minute the boundary switches on is the one that has to be right: the graph resolves a
 * project through membership rows and never reads `ownerId`, so a project whose owner has no row
 * is visible to nobody but an administrator — and that state cannot be repaired from the panel,
 * because the members screen itself sits behind `project-read`. Everything here is about that.
 */
describe('access role seeding', () => {
  let sequelize: Sequelize;
  let Group: any;

  beforeEach(async () => {
    forgetOwnerRoleGroup();
    sequelize = new Sequelize({
      dialect: 'sqlite',
      storage: ':memory:',
      logging: false,
      models: Object.values(agentizModels) as any[],
    });
    Group = sequelize.define(
      'GroupAP',
      {
        id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        name: { type: DataTypes.STRING, allowNull: false },
        description: { type: DataTypes.STRING },
        tokens: { type: DataTypes.JSON },
      },
      { tableName: 'groupap', timestamps: true },
    );
    await sequelize.sync({ force: true });
  });

  it('sows every role group once and never rewrites an existing one', async () => {
    const first = await installAgentizAccessRoles();
    expect(first.groupsCreated).toBe(seededGroups().length);

    // An operator edited a role in the panel; the next boot must leave that edit alone.
    const observers = await Group.findOne({ where: { name: 'Agentiz · Наблюдатели' } as any });
    await observers.update({ tokens: ['agentiz-project-read'] });

    const second = await installAgentizAccessRoles();
    expect(second.groupsCreated).toBe(0);
    const reread = await Group.findOne({ where: { name: 'Agentiz · Наблюдатели' } as any });
    expect((reread.get({ plain: true }) as any).tokens).toEqual(['agentiz-project-read']);
  });

  it('backfills a membership row for every owner of a project that has none', async () => {
    // Created before the groups exist: the @AfterCreate hook finds no owner role and skips, which
    // is exactly the state the backfill is for.
    const orphan = await AgentProject.create({ name: 'Old', slug: 'old', ownerId: 42 } as any);
    expect(await AgentProjectMember.count({ where: { projectId: orphan.id } })).toBe(0);

    const seeded = await installAgentizAccessRoles();
    expect(seeded.ownersLinked).toBe(1);
    // The acceptance criterion of the migration minute, stated directly.
    expect(await projectIdsForUser(42)).toEqual([orphan.id]);

    // Idempotent: a second boot writes nothing.
    expect((await installAgentizAccessRoles()).ownersLinked).toBe(0);
  });

  it('gives a project created afterwards its owner row in the same transaction', async () => {
    await installAgentizAccessRoles();
    const ownerGroup = await Group.findOne({ where: { name: ownerRolePreset().name } as any });

    const fresh = await sequelize.transaction(async (transaction) =>
      AgentProject.create({ name: 'New', slug: 'new', ownerId: 7 } as any, { transaction }));

    const row = await AgentProjectMember.findOne({ where: { projectId: fresh.id } });
    expect(row).not.toBeNull();
    expect(row!.userId).toBe(7);
    expect(row!.groupId).toBe(Number((ownerGroup.get({ plain: true }) as any).id));
  });

  it('gives the owner a row when they are named after the project was created', async () => {
    await installAgentizAccessRoles();
    // The path the panel actually takes: adminizer 5.1.0-build.25 no longer stamps the access
    // column for an administrator, so `/model/AgentProject/add` stores an empty `ownerId` and the
    // owner is picked afterwards on the edit screen. Without the update hook this project would
    // stay invisible to its own owner until the next restart.
    const project = await AgentProject.create({ name: 'Later', slug: 'later' } as any);
    expect(await AgentProjectMember.count({ where: { projectId: project.id } })).toBe(0);

    await project.update({ ownerId: 3 });
    const row = await AgentProjectMember.findOne({ where: { projectId: project.id } });
    expect(row?.userId).toBe(3);

    // An unrelated update must not cost a lookup or write a second row.
    await project.update({ name: 'Later still' });
    expect(await AgentProjectMember.count({ where: { projectId: project.id } })).toBe(1);
  });

  it('leaves a project alone once somebody has taken a decision about its members', async () => {
    await installAgentizAccessRoles();
    const project = await AgentProject.create({ name: 'Team', slug: 'team', ownerId: 9 } as any);
    // The owner's own row removed deliberately, but somebody else is in the project: the backfill
    // must not undo that decision — it only ever fixes "нет ни одной строки".
    await AgentProjectMember.destroy({ where: { projectId: project.id, userId: 9 } });
    const groupId = Number((await Group.findOne({ where: { name: ownerRolePreset().name } as any })).get({ plain: true }).id);
    await AgentProjectMember.create({ projectId: project.id, userId: 10, groupId } as any);

    expect((await installAgentizAccessRoles()).ownersLinked).toBe(0);
    expect(await AgentProjectMember.count({ where: { projectId: project.id, userId: 9 } })).toBe(0);
  });

  it('does not break project creation where there is no panel at all', async () => {
    // No GroupAP model: unit tests, a worker-only process. Creating a project must still work.
    const bare = new Sequelize({
      dialect: 'sqlite', storage: ':memory:', logging: false,
      models: Object.values(agentizModels) as any[],
    });
    await bare.sync({ force: true });
    forgetOwnerRoleGroup();
    await expect(AgentProject.create({ name: 'Bare', slug: 'bare', ownerId: 5 } as any)).resolves.toBeTruthy();
    await bare.close();
  });
});
