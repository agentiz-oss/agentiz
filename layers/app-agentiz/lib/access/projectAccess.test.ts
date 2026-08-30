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
import {
  ProjectAccessError,
  assertCan,
  can,
  createAccessCache,
  projectIdsForUser,
  recipientsForProject,
  tokensInProject,
} from './projectAccess';
import { PROJECT_TOKENS, GLOBAL_TOKENS } from './tokens';

/**
 * The point of the whole design, stated as a test: the same person holds different rights in two
 * projects, because the rights come from the role group named by the membership row and not from
 * `user.groups`. If `tokensInProject` ever answered the same thing in both, the boundary would be
 * a global one wearing a project's name.
 */
describe('projectAccess', () => {
  let sequelize: Sequelize;
  let alpha: AgentProject;
  let beta: AgentProject;
  let testerGroupId: number;
  let developerGroupId: number;

  const OWNER = 7;
  const MEMBER = 8;
  const STRANGER = 9;

  beforeEach(async () => {
    sequelize = new Sequelize({
      dialect: 'sqlite',
      storage: ':memory:',
      logging: false,
      models: Object.values(agentizModels) as any[],
    });
    // The panel's own group table, defined here the way app-adminizer defines it — the access
    // helpers reach it through `sequelize.model('GroupAP')`, exactly as the runtime does.
    const Group = sequelize.define(
      'GroupAP',
      {
        id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        name: { type: DataTypes.STRING, allowNull: false },
        tokens: { type: DataTypes.JSON },
      },
      { tableName: 'groupap', timestamps: true },
    );
    await sequelize.sync({ force: true });

    const tester = await Group.create({
      name: 'Agentiz · Тестировщики',
      tokens: [PROJECT_TOKENS.read, PROJECT_TOKENS.runOperate, PROJECT_TOKENS.approvalDecide],
    } as any);
    const developer = await Group.create({
      name: 'Agentiz · Разработчики',
      tokens: [PROJECT_TOKENS.read, PROJECT_TOKENS.taskWrite, PROJECT_TOKENS.diffReview],
    } as any);
    testerGroupId = Number((tester.get({ plain: true }) as any).id);
    developerGroupId = Number((developer.get({ plain: true }) as any).id);

    alpha = await AgentProject.create({ name: 'Alpha', slug: 'alpha', ownerId: OWNER } as any);
    beta = await AgentProject.create({ name: 'Beta', slug: 'beta', ownerId: null } as any);

    await AgentProjectMember.create({ projectId: alpha.id, userId: MEMBER, groupId: testerGroupId } as any);
    await AgentProjectMember.create({ projectId: beta.id, userId: MEMBER, groupId: developerGroupId } as any);
  });

  it('gives one person different tokens in two projects', async () => {
    const inAlpha = await tokensInProject(MEMBER, alpha.id);
    const inBeta = await tokensInProject(MEMBER, beta.id);

    expect(inAlpha.has(PROJECT_TOKENS.approvalDecide)).toBe(true);
    expect(inAlpha.has(PROJECT_TOKENS.diffReview)).toBe(false);
    expect(inBeta.has(PROJECT_TOKENS.diffReview)).toBe(true);
    expect(inBeta.has(PROJECT_TOKENS.approvalDecide)).toBe(false);
  });

  it('lets the owner do everything in their own project without a membership row', async () => {
    expect(await can(OWNER, alpha.id, PROJECT_TOKENS.projectConfigure)).toBe(true);
    expect(await can(OWNER, beta.id, PROJECT_TOKENS.read)).toBe(false);
  });

  it('answers no to somebody with no row at all', async () => {
    expect(await can(STRANGER, alpha.id, PROJECT_TOKENS.read)).toBe(false);
    expect(await projectIdsForUser(STRANGER)).toEqual([]);
  });

  it('lets an administrator and the bypass token past the whole thing', async () => {
    const admin = { id: 100, isAdministrator: true };
    const support = { id: 101, groups: [{ tokens: [GLOBAL_TOKENS.projectAdmin] }] };
    expect(await can(admin, beta.id, PROJECT_TOKENS.projectConfigure)).toBe(true);
    expect(await can(support, beta.id, PROJECT_TOKENS.projectConfigure)).toBe(true);
    expect((await projectIdsForUser(support)).sort()).toEqual([alpha.id, beta.id].sort());
  });

  it('lists projects by ownership union membership, and narrows them by token', async () => {
    expect((await projectIdsForUser(MEMBER)).sort()).toEqual([alpha.id, beta.id].sort());
    expect(await projectIdsForUser(MEMBER, PROJECT_TOKENS.diffReview)).toEqual([beta.id]);
    // The owner keeps their project whatever the token, which is what stops a role-group edit from
    // making a project vanish from its own owner's list.
    expect(await projectIdsForUser(OWNER, PROJECT_TOKENS.diffReview)).toEqual([alpha.id]);
  });

  it('addresses a notification to the owner plus the members the token applies to', async () => {
    expect((await recipientsForProject(alpha.id)).sort()).toEqual([OWNER, MEMBER].sort());
    expect(await recipientsForProject(alpha.id, PROJECT_TOKENS.approvalDecide)).toContain(MEMBER);
    expect(await recipientsForProject(beta.id, PROJECT_TOKENS.approvalDecide)).toEqual([]);
  });

  it('says 404 for a project it may not read and 403 for one it may', async () => {
    await expect(assertCan(STRANGER, alpha.id, PROJECT_TOKENS.read)).rejects.toMatchObject({ status: 404 });
    await expect(assertCan(MEMBER, alpha.id, PROJECT_TOKENS.diffReview)).rejects.toBeInstanceOf(ProjectAccessError);
    await expect(assertCan(MEMBER, alpha.id, PROJECT_TOKENS.diffReview)).rejects.toMatchObject({ status: 403 });
    await expect(assertCan(MEMBER, alpha.id, PROJECT_TOKENS.approvalDecide)).resolves.toBeUndefined();
  });

  it('reuses one answer per request when handed a cache', async () => {
    const cache = createAccessCache();
    const spy = vi.spyOn(AgentProjectMember, 'findAll');
    await can(MEMBER, alpha.id, PROJECT_TOKENS.runOperate, cache);
    await can(MEMBER, alpha.id, PROJECT_TOKENS.approvalDecide, cache);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
