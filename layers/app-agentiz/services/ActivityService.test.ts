import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../models';
import { AgentActivity } from '../models/AgentActivity';
import { AgentProject } from '../models/AgentProject';
import { AgentRun } from '../models/AgentRun';
import { AgentTask } from '../models/AgentTask';
import {
  listActivityNotifiers,
  registerActivityNotifier,
  unregisterActivityNotifier,
} from '../lib/activityNotifiers';
import type { ActivityEvent } from '../lib/activityNotifiers';
import { ActivityService } from './ActivityService';

const OWNER = 21;

/** Fan-out is fire-and-forget; give the queued microtasks a chance to run before asserting. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('ActivityService', () => {
  let sequelize: Sequelize;
  let projectId: string;
  let taskId: string;
  let runId: string;

  const pushCalls: ActivityEvent[] = [];
  const dashboardCalls: ActivityEvent[] = [];

  beforeAll(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, models: Object.values(agentizModels) as any[] });
  });

  afterAll(async () => sequelize.close());

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    pushCalls.length = 0;
    dashboardCalls.length = 0;
    delete process.env.AGENTIZ_NOTIFY_POLICY;
    registerActivityNotifier({ id: 'test:push', channel: 'push', notify: (event) => { pushCalls.push(event); } });
    registerActivityNotifier({ id: 'test:dashboard', channel: 'dashboard', notify: (event) => { dashboardCalls.push(event); } });

    const project = await AgentProject.create({ name: 'Owned', slug: 'owned', ownerId: OWNER } as any);
    const task = await AgentTask.create({ projectId: project.id, externalId: 'local:1', title: 'Починить деплой', status: 'in_progress', priority: 'normal' } as any);
    const run = await AgentRun.create({
      projectId: project.id, taskId: task.id, status: 'running', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'none' } }, pipelineSpecId: 'spec-1',
    } as any);
    projectId = project.id;
    taskId = task.id;
    runId = run.id;
  });

  afterEach(() => {
    for (const notifier of listActivityNotifiers()) unregisterActivityNotifier(notifier.id);
    delete process.env.AGENTIZ_NOTIFY_POLICY;
  });

  const record = (type = 'run.failed', extra: Record<string, unknown> = {}) => ActivityService.record({
    type,
    projectId,
    runId,
    title: 'Запуск завершился с ошибкой',
    body: 'git preflight failed',
    ...extra,
  });

  it('writes the feed row and hands every notifier the resolved context', async () => {
    const activity = await record();
    expect(activity).not.toBeNull();
    expect(await AgentActivity.count()).toBe(1);
    expect(activity).toMatchObject({ type: 'run.failed', kind: 'info', projectId, runId, taskId });

    await settled();
    expect(pushCalls).toHaveLength(1);
    expect(dashboardCalls).toHaveLength(1);
    const event = pushCalls[0];
    // The context is resolved once, here — notifiers must not need their own queries.
    expect(event.context).toMatchObject({ ownerId: OWNER, projectName: 'Owned', taskTitle: 'Починить деплой' });
    expect(event.context.run?.id).toBe(runId);
    expect(event.delivery).toEqual({ push: 'on', dashboard: 'on' });
  });

  it('always writes the row even when the policy silences both channels', async () => {
    process.env.AGENTIZ_NOTIFY_POLICY = JSON.stringify({ projects: { [projectId]: { mute: true } } });

    const activity = await record();

    expect(activity).not.toBeNull();
    expect(await AgentActivity.count()).toBe(1);
    await settled();
    expect(pushCalls).toHaveLength(0);
    expect(dashboardCalls).toHaveLength(0);
  });

  it('skips only the channel the policy turned off', async () => {
    process.env.AGENTIZ_NOTIFY_POLICY = JSON.stringify({ defaults: { 'run.failed': { push: 'off' } } });

    await record();
    await settled();

    expect(pushCalls).toHaveLength(0);
    expect(dashboardCalls).toHaveLength(1);
  });

  it('delivers silent as silent, not as off', async () => {
    process.env.AGENTIZ_NOTIFY_POLICY = JSON.stringify({ defaults: { 'run.failed': { push: 'silent' } } });

    await record();
    await settled();

    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].delivery.push).toBe('silent');
  });

  it('lets the pipeline scope override a muted project', async () => {
    process.env.AGENTIZ_NOTIFY_POLICY = JSON.stringify({
      projects: { [projectId]: { mute: true } },
      pipelines: { 'spec-1': { 'run.failed': { push: 'on' } } },
    });

    await record();
    await settled();

    expect(pushCalls).toHaveLength(1);
    // Only push was explicitly re-enabled; dashboard still falls through to the project mute.
    expect(dashboardCalls).toHaveLength(0);
  });

  it('isolates a notifier that throws', async () => {
    registerActivityNotifier({ id: 'test:broken', channel: 'push', notify: () => { throw new Error('boom'); } });

    const activity = await record();
    await settled();

    expect(activity).not.toBeNull();
    expect(pushCalls).toHaveLength(1);
    expect(dashboardCalls).toHaveLength(1);
  });

  it('refuses a type missing from the catalogue without throwing at the caller', async () => {
    const activity = await ActivityService.record({ type: 'made.up', projectId, title: 't', body: 'b' });
    expect(activity).toBeNull();
    expect(await AgentActivity.count()).toBe(0);
  });

  it('returns null instead of throwing when the project is gone', async () => {
    const activity = await ActivityService.record({ type: 'run.failed', projectId: 'missing', title: 't', body: 'b' });
    expect(activity).toBeNull();
  });
});

/**
 * The AgentRun model hook — the single emitter of run.succeeded/failed/cancelled. What matters:
 * exactly one activity per terminal *transition*, and none for anything else, including the bulk
 * update path the model comment forbids (the test documents the limitation rather than fixing it).
 */
describe('AgentRun terminal-status hook', () => {
  let sequelize: Sequelize;
  let projectId: string;
  let run: AgentRun;

  beforeAll(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, models: Object.values(agentizModels) as any[] });
  });

  afterAll(async () => sequelize.close());

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    delete process.env.AGENTIZ_NOTIFY_POLICY;
    const project = await AgentProject.create({ name: 'Owned', slug: 'owned', ownerId: OWNER } as any);
    const task = await AgentTask.create({ projectId: project.id, externalId: 'local:1', title: 'Задача', status: 'running', priority: 'normal' } as any);
    run = await AgentRun.create({
      projectId: project.id, taskId: task.id, status: 'running', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
    } as any);
    projectId = project.id;
  });

  it('emits exactly once on the first terminal transition', async () => {
    await run.update({ status: 'failed', errorMessage: 'stage exploded' });

    const rows = await AgentActivity.findAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'run.failed', projectId, runId: run.id });
    expect(rows[0].body).toContain('stage exploded');
  });

  it('records run.cancelled too — delivery defaults off, history is not', async () => {
    await run.update({ status: 'cancelled' });
    expect(await AgentActivity.count({ where: { type: 'run.cancelled' } })).toBe(1);
  });

  it('stays silent on non-terminal transitions and on repeated terminal updates', async () => {
    await run.update({ status: 'waiting_input' });
    expect(await AgentActivity.count()).toBe(0);

    await run.update({ status: 'succeeded', resultSummary: 'done' });
    expect(await AgentActivity.count()).toBe(1);

    // Updating a finished run (even its status field again) must not re-announce it.
    await run.update({ resultSummary: 'done, really' });
    await run.update({ status: 'failed' });
    expect(await AgentActivity.count()).toBe(1);
  });

  it('does not fire on a bulk update — the documented limitation behind "instance update only"', async () => {
    await AgentRun.update({ status: 'failed' } as any, { where: { id: run.id } });
    expect(await AgentActivity.count()).toBe(0);
  });
});
