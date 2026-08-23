import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../../app-agentiz/models';
import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { AgentRun } from '../../app-agentiz/models/AgentRun';
import { AgentRunInteraction } from '../../app-agentiz/models/AgentRunInteraction';
import { AgentRunJob } from '../../app-agentiz/models/AgentRunJob';
import { AgentStageExecution } from '../../app-agentiz/models/AgentStageExecution';
import { AgentTask } from '../../app-agentiz/models/AgentTask';
import { MobileInteractionService } from './MobileInteractionService';
import { MobileInboxDismissal } from '../models/MobileInboxDismissal';

const OWNER = 7;
const STRANGER = 8;

/**
 * The mobile surface of agent questions. Two things are actually at stake here: that a question is
 * reachable only through a project the caller owns, and that answering one goes through the core
 * service — schema validation and the run leaving `waiting_input` included.
 */
describe('MobileInteractionService', () => {
  let sequelize: Sequelize;
  let interactionId: string;
  let runId: string;
  let taskId: string;

  beforeAll(async () => {
    sequelize = new Sequelize({
      dialect: 'sqlite',
      storage: ':memory:',
      logging: false,
      models: [...(Object.values(agentizModels) as any[]), MobileInboxDismissal],
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
      title: 'Task',
      status: 'waiting_input',
      priority: 'normal',
    } as any);
    const run = await AgentRun.create({
      projectId: project.id,
      taskId: task.id,
      pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
      status: 'waiting_input',
      trigger: 'manual',
      currentStageIndex: 0,
    } as any);
    const stage = await AgentStageExecution.create({
      runId: run.id,
      stageIndex: 0,
      role: 'implement',
      agentRoleId: null,
      status: 'waiting_input',
    } as any);
    const job = await AgentRunJob.create({
      projectId: project.id,
      runId: run.id,
      status: 'running',
      attempt: 1,
      workerId: 'worker-1',
      snapshot: {},
    } as any);
    const interaction = await AgentRunInteraction.create({
      projectId: project.id,
      runId: run.id,
      jobId: job.id,
      attempt: 1,
      stageExecutionId: stage.id,
      kind: 'elicitation',
      source: 'claude',
      externalRequestId: 'req-1',
      message: 'Какую ветку использовать?',
      requestedSchema: {
        type: 'object',
        required: ['branch'],
        properties: { branch: { type: 'string' } },
      },
      status: 'pending',
    } as any);
    interactionId = interaction.id;
    runId = run.id;
    taskId = task.id;
  });

  it('lists a pending question with its task and stage context', async () => {
    const rows = await MobileInteractionService.listPending(OWNER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: interactionId,
      taskId,
      taskTitle: 'Task',
      projectName: 'Owned',
      stageRole: 'implement',
      status: 'pending',
    });
  });

  it('shows nothing to a user who does not own the project', async () => {
    expect(await MobileInteractionService.listPending(STRANGER)).toEqual([]);
  });

  it('records the answer and leaves the run parked until the worker collects it', async () => {
    const answered = await MobileInteractionService.answer(
      interactionId,
      OWNER,
      'accept',
      { branch: 'main' },
      { id: OWNER, name: 'owner' },
    );
    expect(answered.status).toBe('answered');
    expect(answered.answeredByName).toBe('owner');
    // `answered` is not yet `delivered`: the worker is long-polling for this and acknowledges it,
    // and only that ACK moves the run back to `running`. The app must therefore keep polling after
    // submitting rather than assuming the pause is over.
    expect((await AgentRun.findByPk(runId))!.status).toBe('waiting_input');
  });

  it('rejects an answer that does not match the question schema', async () => {
    await expect(
      MobileInteractionService.answer(interactionId, OWNER, 'accept', { branch: 42 }, { id: OWNER, name: 'owner' }),
    ).rejects.toThrow(/requestedSchema/);
  });

  it('reports someone else\'s question as missing rather than forbidden', async () => {
    await expect(
      MobileInteractionService.answer(interactionId, STRANGER, 'accept', { branch: 'main' }, { id: STRANGER, name: 'other' }),
    ).rejects.toMatchObject({ status: 404 });
    // And it is still open for the person it was actually asked of.
    expect((await AgentRunInteraction.findByPk(interactionId))!.status).toBe('pending');
  });

  it('carries a run\'s questions alongside its result', async () => {
    const rows = await MobileInteractionService.forRun(runId);
    expect(rows.map((row) => row.id)).toEqual([interactionId]);
    expect(rows[0].requestedSchema).toMatchObject({ type: 'object' });
  });
});
