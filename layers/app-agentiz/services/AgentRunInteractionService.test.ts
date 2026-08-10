import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../models';
import { AgentProject } from '../models/AgentProject';
import { AgentRun } from '../models/AgentRun';
import { AgentRunInteraction } from '../models/AgentRunInteraction';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentStageExecution } from '../models/AgentStageExecution';
import { AgentTask } from '../models/AgentTask';
import { AgentRunInteractionService } from './AgentRunInteractionService';

describe('AgentRunInteractionService', () => {
  let sequelize: Sequelize;
  let job: AgentRunJob;
  let stage: AgentStageExecution;

  beforeAll(async () => {
    sequelize = new Sequelize({
      dialect: 'sqlite',
      storage: ':memory:',
      logging: false,
      models: Object.values(agentizModels) as any[],
    });
  });

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    const project = await AgentProject.create({ name: 'Test', slug: 'test', ownerId: 7 } as any);
    const task = await AgentTask.create({
      projectId: project.id,
      externalId: 'local:1',
      title: 'Task',
      status: 'running',
      priority: 'normal',
    } as any);
    const run = await AgentRun.create({
      projectId: project.id,
      taskId: task.id,
      pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
      status: 'running',
      trigger: 'manual',
      currentStageIndex: 0,
    } as any);
    stage = await AgentStageExecution.create({
      runId: run.id,
      stageIndex: 0,
      role: 'implement',
      agentRoleId: null,
      status: 'running',
    } as any);
    job = await AgentRunJob.create({
      projectId: project.id,
      runId: run.id,
      status: 'running',
      attempt: 1,
      workerId: 'worker-1',
      leaseTokenHash: 'hash',
      lockedUntil: new Date(Date.now() + 60_000),
      availableAt: new Date(),
      snapshot: {},
    } as any);
  });

  afterAll(async () => {
    await sequelize.close();
  });

  const request = (externalRequestId = 'request-1') => ({
    externalRequestId,
    stageExecutionId: stage.id,
    source: 'codex',
    message: 'Choose a strategy',
    requestedSchema: {
      type: 'object',
      properties: { strategy: { type: 'string', enum: ['safe', 'fast'] } },
      required: ['strategy'],
      additionalProperties: false,
    },
  });

  it('is idempotent and resumes only after a valid answer is acknowledged', async () => {
    const interaction = await AgentRunInteractionService.create(job, request());
    const duplicate = await AgentRunInteractionService.create(job, request());
    expect(duplicate.id).toBe(interaction.id);
    expect((await AgentRun.findByPk(job.runId))?.status).toBe('waiting_input');
    expect((await AgentTask.findOne({ where: { projectId: job.projectId } }))?.status).toBe('waiting_input');
    expect((await stage.reload()).status).toBe('waiting_input');

    await expect(AgentRunInteractionService.answer(
      interaction.id,
      'accept',
      { strategy: 'unknown' },
      { id: 7, name: 'owner' },
    )).rejects.toMatchObject({ status: 400 });

    const answered = await AgentRunInteractionService.answer(
      interaction.id,
      'accept',
      { strategy: 'safe' },
      { id: 7, name: 'owner' },
    );
    expect(answered.status).toBe('answered');
    expect((await AgentRun.findByPk(job.runId))?.status).toBe('waiting_input');
    await expect(AgentRunInteractionService.answer(
      interaction.id,
      'decline',
      null,
      { id: 7, name: 'owner' },
    )).rejects.toMatchObject({ status: 409 });

    const delivered = await AgentRunInteractionService.acknowledge(job, interaction.id);
    expect(delivered.status).toBe('delivered');
    expect((await AgentRun.findByPk(job.runId))?.status).toBe('running');
    expect((await stage.reload()).status).toBe('running');
  });

  it('denies a user from another project and rejects sensitive form fields', async () => {
    const interaction = await AgentRunInteractionService.create(job, request());
    await expect(AgentRunInteractionService.answer(
      interaction.id,
      'accept',
      { strategy: 'safe' },
      { id: 8, name: 'other' },
    )).rejects.toMatchObject({ status: 403 });

    await expect(AgentRunInteractionService.create(job, {
      ...request('request-2'),
      requestedSchema: { type: 'object', properties: { api_key: { type: 'string' } } },
    })).rejects.toMatchObject({ status: 400 });
    expect(await AgentRunInteraction.count()).toBe(1);
  });

  it('keeps the run waiting until every question is delivered and orphans an expired attempt', async () => {
    const first = await AgentRunInteractionService.create(job, request('request-1'));
    const second = await AgentRunInteractionService.create(job, request('request-2'));
    expect(await AgentRunInteractionService.hasUnresolved(job)).toBe(true);

    await AgentRunInteractionService.answer(first.id, 'decline', null, { id: 7, name: 'owner' });
    await AgentRunInteractionService.acknowledge(job, first.id);
    expect((await AgentRun.findByPk(job.runId))?.status).toBe('waiting_input');

    await AgentRunInteractionService.answer(second.id, 'cancel', null, { id: 7, name: 'owner' });
    await AgentRunInteractionService.acknowledge(job, second.id);
    expect(await AgentRunInteractionService.hasUnresolved(job)).toBe(false);
    expect((await AgentRun.findByPk(job.runId))?.status).toBe('running');

    const third = await AgentRunInteractionService.create(job, request('request-3'));
    await AgentRunInteractionService.closeForJob(job, 'orphaned', 'lease expired');
    expect((await third.reload()).status).toBe('orphaned');
    expect((await AgentRun.findByPk(job.runId))?.status).toBe('running');
  });
});
