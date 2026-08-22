import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../../app-agentiz/models';
import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { AgentRun } from '../../app-agentiz/models/AgentRun';
import { AgentTask } from '../../app-agentiz/models/AgentTask';
import { AgentTaskComment } from '../../app-agentiz/models/AgentTaskComment';
import { MobileTaskService } from './MobileTaskService';

const OWNER = 21;
const STRANGER = 22;

/**
 * One run loaded on its own. The app reaches this endpoint from places that hold nothing but a task
 * id and a run id — the run board, the activity feed, a tapped notification — so the payload has to
 * name the task and project it belongs to, or the screen it feeds becomes a dead end.
 */
describe('MobileTaskService.runDetailForTask', () => {
  let sequelize: Sequelize;
  let taskId: string;
  let runId: string;

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

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    const project = await AgentProject.create({ name: 'Owned', slug: 'owned', ownerId: OWNER } as any);
    const task = await AgentTask.create({
      projectId: project.id,
      externalId: 'local:1',
      title: 'Починить пуши на iOS',
      status: 'in_progress',
      priority: 'normal',
    } as any);
    const run = await AgentRun.create({
      projectId: project.id,
      taskId: task.id,
      pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
      status: 'succeeded',
      trigger: 'manual',
      currentStageIndex: 0,
    } as any);
    taskId = task.id;
    runId = run.id;
  });

  it('names the task and project the run belongs to', async () => {
    const detail = await MobileTaskService.runDetailForTask(taskId, runId, OWNER);
    expect(detail).toMatchObject({
      id: runId,
      status: 'succeeded',
      taskId,
      taskTitle: 'Починить пуши на iOS',
      projectName: 'Owned',
    });
    expect(detail.projectId).toBe((await AgentTask.findByPk(taskId))!.projectId);
  });

  it('still refuses a run in somebody else\'s project', async () => {
    // The context is read from the very rows that authorise the call, so widening the payload must
    // not have widened who may ask for it.
    await expect(MobileTaskService.runDetailForTask(taskId, runId, STRANGER)).rejects.toThrow('Task not found');
  });

  it('carries the instruction the run was started from, not just the task\'s name', async () => {
    // The trigger comment is what the worker puts last in the prompt as the current instruction —
    // a run screen that shows only "Починить пуши на iOS" says nothing about what was asked this
    // time round.
    const comment = await AgentTaskComment.create({
      taskId, authorKind: 'human', authorName: 'Иван', body: 'проверь зависимости и обнови мажоры',
    } as any);
    const run = await AgentRun.findByPk(runId);
    await run!.update({ triggerCommentId: comment.id });

    expect((await MobileTaskService.runDetailForTask(taskId, runId, OWNER)).instruction).toMatchObject({
      source: 'comment', body: 'проверь зависимости и обнови мажоры', authorName: 'Иван',
    });

    // With no trigger comment the task's own description is the instruction; with neither, nothing
    // is invented.
    await run!.update({ triggerCommentId: null });
    expect((await MobileTaskService.runDetailForTask(taskId, runId, OWNER)).instruction).toBeNull();
    await (await AgentTask.findByPk(taskId))!.update({ description: 'Пуши не приходят на iOS 18' });
    expect((await MobileTaskService.runDetailForTask(taskId, runId, OWNER)).instruction).toMatchObject({
      source: 'description', body: 'Пуши не приходят на iOS 18',
    });
  });

  it('the copy embedded in a task keeps its context out', async () => {
    // The task screen already knows whose task it is; repeating it in `latestRun` would only put
    // the same two strings on the wire on every poll.
    const detail = await MobileTaskService.detail(taskId, OWNER);
    expect(detail.latestRun).toMatchObject({ id: runId });
    expect(detail.latestRun).not.toHaveProperty('taskTitle');
  });
});
