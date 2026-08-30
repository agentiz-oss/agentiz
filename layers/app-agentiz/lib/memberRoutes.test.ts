import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { DataTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../models';
import { AgentProject } from '../models/AgentProject';
import { AgentProjectMember } from '../models/AgentProjectMember';
import { memberRoutes } from './memberRoutes';
import { PROJECT_TOKENS, ROLE_PRESETS } from './access/tokens';

/**
 * What the members screen must and must not do.
 *
 * The "must not" is the important half and it is why this test exists at all: the screen edits
 * membership rows and nothing else. If it ever grew the ability to edit a group — the obvious next
 * convenience — handing out access in one project would silently change what that role means in
 * every other one, and could take somebody's access to an unrelated part of the panel away.
 */
describe('member routes', () => {
  let sequelize: Sequelize;
  let Group: any;
  let project: AgentProject;
  let testerGroupId: number;
  let maintainerGroupId: number;

  const OWNER = 1;
  const MAINTAINER = 2;
  const TESTER = 3;

  const get = memberRoutes.find((route) => route.method === 'get')!.handler as any;
  const post = memberRoutes.find((route) => route.method === 'post')!.handler as any;

  const response = () => {
    const sent: any = { code: 200 };
    sent.status = (code: number) => { sent.code = code; return sent; };
    sent.json = (body: any) => { sent.body = body; return sent; };
    return sent;
  };

  const asUser = (id: number) => ({ session: { UserAP: { id } }, user: { id } });

  const call = async (handler: any, payload: Record<string, unknown>, userId: number) => {
    const sent = response();
    await handler({ ...asUser(userId), query: payload, body: payload }, sent);
    return sent;
  };

  beforeEach(async () => {
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
    sequelize.define(
      'UserAP',
      {
        id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        login: { type: DataTypes.STRING },
        fullName: { type: DataTypes.STRING },
        email: { type: DataTypes.STRING },
      },
      { tableName: 'userap', timestamps: true },
    );
    await sequelize.sync({ force: true });

    const User = sequelize.model('UserAP');
    await User.bulkCreate([
      { id: OWNER, login: 'owner', fullName: 'Владелец', email: 'owner@example.com' },
      { id: MAINTAINER, login: 'maint', fullName: 'Мейнтейнер', email: 'maint@example.com' },
      { id: TESTER, login: 'tester', fullName: 'Тестировщик', email: 'tester@example.com' },
    ] as any);

    const preset = (key: string) => ROLE_PRESETS.find((item) => item.key === key)!;
    const tester = await Group.create({ name: preset('tester').name, tokens: preset('tester').tokens } as any);
    const maintainer = await Group.create({ name: preset('maintainer').name, tokens: preset('maintainer').tokens } as any);
    testerGroupId = Number((tester.get({ plain: true }) as any).id);
    maintainerGroupId = Number((maintainer.get({ plain: true }) as any).id);

    project = await AgentProject.create({ name: 'Alpha', slug: 'alpha', ownerId: OWNER } as any);
    await AgentProjectMember.create({ projectId: project.id, userId: MAINTAINER, groupId: maintainerGroupId } as any);
  });

  it('adds a member, changes their role and removes them', async () => {
    const added = await call(post, { _method: 'addMember', projectId: project.id, userId: TESTER, groupId: testerGroupId }, MAINTAINER);
    expect(added.code).toBe(200);

    const listed = await call(get, { _method: 'list', projectId: project.id }, MAINTAINER);
    const tester = listed.body.data.find((row: any) => row.userId === TESTER);
    expect(tester.presetKey).toBe('tester');
    expect(tester.grantedBy.id).toBe(MAINTAINER);
    expect(listed.body.meta.canManage).toBe(true);

    const changed = await call(post, { _method: 'setRole', memberId: tester.id, groupId: maintainerGroupId }, MAINTAINER);
    expect(changed.code).toBe(200);
    expect((await AgentProjectMember.findByPk(tester.id))!.groupId).toBe(maintainerGroupId);

    const removed = await call(post, { _method: 'removeMember', memberId: tester.id }, MAINTAINER);
    expect(removed.code).toBe(200);
    expect(await AgentProjectMember.findByPk(tester.id)).toBeNull();
  });

  it('leaves the groups and their tokens untouched by every operation', async () => {
    const before = (await Group.findAll()).map((group: any) => group.get({ plain: true }));
    await call(post, { _method: 'addMember', projectId: project.id, userId: TESTER, groupId: testerGroupId }, MAINTAINER);
    const member = (await AgentProjectMember.findOne({ where: { userId: TESTER } }))!;
    await call(post, { _method: 'setRole', memberId: member.id, groupId: maintainerGroupId }, MAINTAINER);
    await call(post, { _method: 'removeMember', memberId: member.id }, MAINTAINER);

    const after = (await Group.findAll()).map((group: any) => group.get({ plain: true }));
    expect(after.map((g: any) => [g.id, g.name, g.tokens])).toEqual(before.map((g: any) => [g.id, g.name, g.tokens]));
  });

  it('refuses to remove the owner: their row is what makes the project visible to them', async () => {
    const ownerRow = await AgentProjectMember.create({ projectId: project.id, userId: OWNER, groupId: maintainerGroupId } as any);
    const refused = await call(post, { _method: 'removeMember', memberId: ownerRow.id }, MAINTAINER);
    expect(refused.code).toBe(409);
    expect(await AgentProjectMember.findByPk(ownerRow.id)).not.toBeNull();
  });

  it('lets a member read the list but not change it', async () => {
    await AgentProjectMember.create({ projectId: project.id, userId: TESTER, groupId: testerGroupId } as any);
    const listed = await call(get, { _method: 'list', projectId: project.id }, TESTER);
    expect(listed.code).toBe(200);
    expect(listed.body.meta.canManage).toBe(false);

    const refused = await call(post, { _method: 'addMember', projectId: project.id, userId: 99, groupId: testerGroupId }, TESTER);
    expect(refused.code).toBe(403);
  });

  it('answers 404, not 403, to somebody with no part in the project', async () => {
    const listed = await call(get, { _method: 'list', projectId: project.id }, 99);
    expect(listed.code).toBe(404);
  });

  it('refuses the same role twice for the same person', async () => {
    await call(post, { _method: 'addMember', projectId: project.id, userId: TESTER, groupId: testerGroupId }, MAINTAINER);
    const again = await call(post, { _method: 'addMember', projectId: project.id, userId: TESTER, groupId: testerGroupId }, MAINTAINER);
    expect(again.code).toBe(409);
  });

  it('names the role by its ladder step, and says "особая" when the tokens match none', async () => {
    const odd = await Group.create({ name: 'Что-то своё', tokens: [PROJECT_TOKENS.read] } as any);
    await AgentProjectMember.create({
      projectId: project.id, userId: TESTER, groupId: Number((odd.get({ plain: true }) as any).id),
    } as any);
    const listed = await call(get, { _method: 'list', projectId: project.id }, MAINTAINER);
    const row = listed.body.data.find((item: any) => item.userId === TESTER);
    expect(row.presetKey).toBeNull();
    expect(row.groupName).toBe('Что-то своё');
  });
});
