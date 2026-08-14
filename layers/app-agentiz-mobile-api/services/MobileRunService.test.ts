import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../../app-agentiz/models';
import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { AgentRun } from '../../app-agentiz/models/AgentRun';
import { AgentRunLog } from '../../app-agentiz/models/AgentRunLog';
import { AgentStageExecution } from '../../app-agentiz/models/AgentStageExecution';
import { AgentTask } from '../../app-agentiz/models/AgentTask';
import { MobileRunService } from './MobileRunService';

const OWNER = 11;
const STRANGER = 12;

/**
 * The cross-project run board. What matters here is the split between "идёт сейчас" and finished
 * history, and that neither half ever reaches out of the caller's own projects.
 */
describe('MobileRunService.board', () => {
  let sequelize: Sequelize;
  let runningId: string;
  let finishedId: string;

  beforeAll(async () => {
    sequelize = new Sequelize({
      dialect: 'sqlite',
      storage: ':memory:',
      logging: false,
      models: Object.values(agentizModels) as any[],
    });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  const makeRun = async (projectId: string, taskId: string, status: string) =>
    AgentRun.create({
      projectId,
      taskId,
      pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
      status,
      trigger: 'manual',
      currentStageIndex: 0,
    } as any);

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    const project = await AgentProject.create({ name: 'Owned', slug: 'owned', ownerId: OWNER } as any);
    const task = await AgentTask.create({
      projectId: project.id,
      externalId: 'local:1',
      title: 'Task',
      status: 'in_progress',
      priority: 'normal',
    } as any);

    const running = await makeRun(project.id, task.id, 'running');
    await AgentStageExecution.create({
      runId: running.id,
      stageIndex: 0,
      role: 'implement',
      agentRoleId: null,
      status: 'running',
    } as any);
    await AgentRunLog.create({ runId: running.id, projectId: project.id, level: 'info', message: 'первая строка' } as any);
    await AgentRunLog.create({ runId: running.id, projectId: project.id, level: 'info', message: 'последняя строка' } as any);

    const finished = await makeRun(project.id, task.id, 'succeeded');

    // Somebody else's project: present in the tables, never in the payload.
    const other = await AgentProject.create({ name: 'Other', slug: 'other', ownerId: STRANGER } as any);
    const otherTask = await AgentTask.create({
      projectId: other.id,
      externalId: 'local:2',
      title: 'Other task',
      status: 'in_progress',
      priority: 'normal',
    } as any);
    await makeRun(other.id, otherTask.id, 'running');

    runningId = running.id;
    finishedId = finished.id;
  });

  it('separates runs in flight from finished ones and carries their context', async () => {
    const board = await MobileRunService.board(OWNER);
    expect(board.active.map((run) => run.id)).toEqual([runningId]);
    expect(board.recent.map((run) => run.id)).toEqual([finishedId]);
    expect(board.active[0]).toMatchObject({
      taskTitle: 'Task',
      projectName: 'Owned',
      pendingInteractions: 0,
      stages: [{ role: 'implement', status: 'running' }],
    });
    // The newest line, not the first one: a board row reports where a run is now.
    expect(board.active[0].lastLog?.message).toBe('последняя строка');
  });

  it('never shows a run from a project the caller does not own', async () => {
    expect(await MobileRunService.board(STRANGER)).toMatchObject({ recent: [] });
    expect((await MobileRunService.board(STRANGER)).active.map((run) => run.projectId))
      .not.toContain((await AgentRun.findByPk(runningId))!.projectId);
  });
});
