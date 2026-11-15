import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
  AbstractNotificationService: class {},
}));
import { Sequelize } from 'sequelize-typescript';
import type { NodeContext, WorkflowMsg } from '@nodeknit/app-workflow';
import * as agentizModels from '../../models';
import { AgentProject } from '../../models/AgentProject';
import { AgentTask } from '../../models/AgentTask';
import { GitSyncService } from '../../services/GitSyncService';
import { tasksOpenNode } from './nodes';

/**
 * «Держать до пяти задач на публикацию, пополнять не чаще раза в сутки».
 *
 * What is easy to get wrong later is not the count but the three reasons to wait: a run already
 * in the shared directory, a top-up already under way (or failed and left for a person), and the
 * interval — counted from the last top-up task, so a busy worker at the scheduled hour does not
 * cost a whole day.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function context(config: Record<string, unknown>): NodeContext {
  return {
    msg: { payload: {} },
    config,
    specId: 'spec-1',
    runId: 'run-1',
    nodeId: 'node-1',
    logger: silentLogger,
    store: { get: async () => undefined, set: async () => {} },
    emit: () => {},
    host: { checkPermission: async () => true, resolveSecret: async () => undefined, notify: async () => {}, now: () => new Date() },
  };
}

describe('agentiz.tasks.open', () => {
  let sequelize: Sequelize;
  let projectId: string;
  let seq = 0;

  beforeAll(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, models: Object.values(agentizModels) as any[] });
  });
  afterAll(async () => sequelize.close());
  afterEach(() => vi.restoreAllMocks());

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    projectId = (await AgentProject.create({ slug: 'promo', name: 'promo', isActive: true } as any)).id;
    vi.spyOn(GitSyncService, 'syncProject').mockResolvedValue({ projectId, fetched: 0, created: 0, updated: 0, errors: [] });
  });

  async function task(tags: string[], extra: Record<string, unknown> = {}): Promise<AgentTask> {
    seq += 1;
    return AgentTask.create({
      projectId, externalId: `gh-1-${seq}`, title: `Task ${seq}`, status: 'new', priority: 'normal',
      externalStatus: 'open', tags, ...extra,
    } as any);
  }

  const config = { tags: 'publication', prepTags: 'publication-prep', max: 5, minIntervalHours: 23 };

  async function tick(overrides: Record<string, unknown> = {}): Promise<{ msg: WorkflowMsg; output?: string }> {
    return (await tasksOpenNode.executor!.execute(context({ projectId, ...config, ...overrides }))) as { msg: WorkflowMsg; output?: string };
  }

  it('reports the room left, counting only open tasks of that kind', async () => {
    await task(['publication']);
    await task(['publication']);
    await task(['publication'], { externalStatus: 'closed' });
    await task(['bug']);

    const result = await tick();

    expect(result.output).toBe('room');
    expect(result.msg.payload).toMatchObject({ openCount: 2, max: 5, room: 3, openTitles: ['Task 1', 'Task 2'] });
  });

  it('is full at the limit', async () => {
    for (let i = 0; i < 5; i += 1) await task(['publication']);
    expect((await tick()).output).toBe('full');
  });

  it('waits while a top-up is under way, and while a failed one is left for a person', async () => {
    const prep = await task(['publication-prep'], { externalStatus: null, status: 'new' });
    expect((await tick()).msg.payload).toMatchObject({ reason: 'preparing', busyTaskId: prep.id });
    await prep.update({ status: 'failed' });
    expect((await tick()).output).toBe('busy');
  });

  it('waits for a run of any task in the project: they share one directory', async () => {
    await task(['bug'], { status: 'running' });
    expect((await tick()).msg.payload).toMatchObject({ reason: 'run_active' });
  });

  it('tops up at most once per interval, counted from the last top-up task', async () => {
    const prep = await task(['publication-prep'], { externalStatus: null, status: 'done' });
    expect((await tick()).msg.payload).toMatchObject({ reason: 'too_soon' });

    await AgentTask.update({ createdAt: new Date(Date.now() - 24 * 3600_000) } as any, { where: { id: prep.id }, silent: true } as any);
    expect((await tick()).output).toBe('room');
  });

  it('does not decide on stale data', async () => {
    vi.mocked(GitSyncService.syncProject).mockResolvedValue({ projectId, fetched: 0, created: 0, updated: 0, errors: ['Bad credentials'] });
    expect((await tick()).msg.payload).toMatchObject({ reason: 'sync_failed' });
  });

  it('refuses a node with no tags to count', async () => {
    await expect(tick({ tags: '' })).rejects.toThrow(/метки/);
  });
});
