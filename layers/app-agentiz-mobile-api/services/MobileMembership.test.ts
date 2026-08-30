import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { DataTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../../app-agentiz/models';
import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { AgentProjectMember } from '../../app-agentiz/models/AgentProjectMember';
import { AgentTask } from '../../app-agentiz/models/AgentTask';
import { ROLE_PRESETS } from '../../app-agentiz/lib/access/tokens';
import { MobileProjectService } from './MobileProjectService';
import { MobileTaskService } from './MobileTaskService';

/**
 * The acceptance criterion of the whole membership work, stated from the phone's side: a person
 * who is **not** the owner sees the project and its tasks in the app, and what they may *do* there
 * follows their role rather than the fact that they can see it.
 *
 * Before this, the mobile API's only rule was `AgentProject.ownerId === caller`, so a second person
 * on a project simply did not exist to the app.
 */
describe('mobile access through membership', () => {
  let sequelize: Sequelize;
  let Group: any;
  let project: AgentProject;
  let task: AgentTask;

  const OWNER = 1;
  const OBSERVER = 2;
  const DEVELOPER = 3;
  const STRANGER = 4;

  const groupFor = async (key: string) => {
    const preset = ROLE_PRESETS.find((item) => item.key === key)!;
    const row = await Group.create({ name: preset.name, tokens: preset.tokens } as any);
    return Number((row.get({ plain: true }) as any).id);
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
        tokens: { type: DataTypes.JSON },
      },
      { tableName: 'groupap', timestamps: true },
    );
    await sequelize.sync({ force: true });

    project = await AgentProject.create({ name: 'Alpha', slug: 'alpha', ownerId: OWNER } as any);
    task = await AgentTask.create({
      projectId: project.id, externalId: 'local:1', title: 'Починить деплой', status: 'new', priority: 'normal',
    } as any);

    await AgentProjectMember.create({ projectId: project.id, userId: OBSERVER, groupId: await groupFor('observer') } as any);
    await AgentProjectMember.create({ projectId: project.id, userId: DEVELOPER, groupId: await groupFor('developer') } as any);
  });

  it('shows the project to a member who does not own it', async () => {
    expect(await MobileProjectService.listForOwner(OBSERVER)).toHaveLength(1);
    expect(await MobileProjectService.getForOwner(project.id, OBSERVER)).toBeTruthy();
    expect(await MobileProjectService.listForOwner(STRANGER)).toEqual([]);
    expect(await MobileProjectService.getForOwner(project.id, STRANGER)).toBeNull();
  });

  it('shows the project to its owner without any membership row of their own', async () => {
    expect(await MobileProjectService.listForOwner(OWNER)).toHaveLength(1);
  });

  it('lists the tasks of a project the caller is a member of', async () => {
    const rows = await MobileTaskService.listForProject(project.id, OBSERVER);
    expect(rows.map((row: any) => row.title)).toEqual(['Починить деплой']);
  });

  it('lets the role decide what a member may write, not the fact that they can see it', async () => {
    const actor = { id: OBSERVER, name: 'observer' };
    // An observer reads the task…
    await expect(MobileTaskService.detail(task.id, OBSERVER)).resolves.toBeTruthy();
    // …and cannot comment on it, start it, or attach anything to it.
    await expect(MobileTaskService.addComment(task.id, OBSERVER, 'нет', actor)).rejects.toMatchObject({ status: 404 });
    await expect(MobileTaskService.run(task.id, OBSERVER)).rejects.toMatchObject({ status: 404 });

    // The developer on the same project gets past the same guard. The call still fails here —
    // this fixture has no pipeline spec, and a comment tries to continue the work — but it fails
    // for a *pipeline* reason rather than with the 404 the guard produces, which is the whole
    // distinction being asserted.
    await expect(
      MobileTaskService.addComment(task.id, DEVELOPER, 'смотрю', { id: DEVELOPER, name: 'dev' }),
    ).rejects.not.toMatchObject({ status: 404 });
  });

  it('answers 404, never 403, to somebody with no part in the project', async () => {
    await expect(MobileTaskService.detail(task.id, STRANGER)).rejects.toMatchObject({ status: 404 });
    await expect(MobileTaskService.listForProject(project.id, STRANGER)).rejects.toMatchObject({ status: 404 });
  });
});
