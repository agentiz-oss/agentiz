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
import { taskClosed, taskNextNode } from './nodes';

/**
 * «Одна задача за раз, следующая — когда предыдущую закрыли в трекере».
 *
 * The rule a reader cannot recover from the schema is what "закрыта" means: the **tracker's**
 * state, not the local one. A run that pushed its branch leaves the task `done` locally while the
 * issue is open and the PR is under review — and that is precisely when the next task must wait.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function context(config: Record<string, unknown>): NodeContext {
  return {
    msg: { payload: { firedAt: new Date().toISOString() } },
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

describe('agentiz.task.next', () => {
  let sequelize: Sequelize;
  let projectId: string;
  const syncResult = { errors: [] as string[] };

  beforeAll(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, models: Object.values(agentizModels) as any[] });
  });
  afterAll(async () => sequelize.close());
  afterEach(() => vi.restoreAllMocks());

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    projectId = (await AgentProject.create({ slug: 'promo', name: 'promo', isActive: true } as any)).id;
    syncResult.errors = [];
    vi.spyOn(GitSyncService, 'syncProject').mockImplementation(async () => ({ projectId, fetched: 0, created: 0, updated: 0, errors: syncResult.errors }));
  });

  /** An issue mirrored from GitHub, created upstream on `day` of November. */
  async function issue(number: number, day: number, extra: Record<string, unknown> = {}): Promise<AgentTask> {
    return AgentTask.create({
      projectId,
      externalId: `gh-1-${number}`,
      title: `Issue ${number}`,
      status: 'new',
      priority: 'normal',
      externalStatus: 'open',
      tags: [],
      raw: { number, created_at: `2026-11-${String(day).padStart(2, '0')}T10:00:00Z` },
      ...extra,
    } as any);
  }

  /** This node never defers, so its result always carries a message and a port. */
  async function tick(config: Record<string, unknown> = {}): Promise<{ msg: WorkflowMsg; output?: string }> {
    return (await taskNextNode.executor!.execute(context({ projectId, ...config }))) as { msg: WorkflowMsg; output?: string };
  }

  it('picks the oldest issue by the tracker\'s date, not by the order sync wrote the rows', async () => {
    await issue(3, 12);
    await issue(1, 10);
    await issue(2, 11);

    const result = await tick();

    expect(result.output).toBe('picked');
    expect((result.msg.payload as any).title).toBe('Issue 1');
    expect((result.msg.payload as any).taskId).toBeTruthy();
    const picked = await AgentTask.findOne({ where: { externalId: 'gh-1-1' } });
    expect(picked!.workflowStatus).toBe('в работе');
  });

  it('waits while the picked issue is open — even after its run pushed and the task is done locally', async () => {
    const first = await issue(1, 10);
    await issue(2, 11);
    await tick();
    await first.update({ status: 'done' });

    const result = await tick();

    expect(result.output).toBe('busy');
    expect(result.msg.payload).toMatchObject({ reason: 'in_progress', busyTaskId: first.id });
  });

  it('a failed run keeps the queue held: the next issue does not jump over it', async () => {
    const first = await issue(1, 10);
    await issue(2, 11);
    await tick();
    await first.update({ status: 'failed' });

    expect((await tick()).output).toBe('busy');
  });

  it('moves on once the tracker closed the issue, and marks the closed one', async () => {
    const first = await issue(1, 10);
    await issue(2, 11);
    await tick();
    await first.update({ status: 'done', externalStatus: 'closed' });

    const result = await tick();

    expect(result.output).toBe('picked');
    expect((result.msg.payload as any).title).toBe('Issue 2');
    expect((await first.reload()).workflowStatus).toBe('закрыта');
  });

  it('waits for any run in flight in the project, picked by this node or not', async () => {
    const manual = await issue(9, 1, { status: 'running', workflowStatus: null });
    await issue(1, 10);

    const result = await tick();

    expect(result.output).toBe('busy');
    expect(result.msg.payload).toMatchObject({ reason: 'run_active', busyTaskId: manual.id });
  });

  it('answers empty when nothing open is left, and never takes a closed issue', async () => {
    await issue(1, 10, { externalStatus: 'closed' });
    expect((await tick()).output).toBe('empty');
  });

  it('honours label filters', async () => {
    await issue(1, 10, { tags: ['hold'] });
    await issue(2, 11, { tags: ['discussion'] });
    await issue(3, 12, { tags: ['agent'] });

    expect(((await tick({ skipTags: 'hold, discussion' })).msg.payload as any).title).toBe('Issue 3');
    await sequelize.sync({ force: true });
    projectId = (await AgentProject.create({ slug: 'p2', name: 'p2', isActive: true } as any)).id;
    await issue(1, 10);
    await issue(2, 11, { tags: ['agent'] });
    expect(((await tick({ tags: 'agent' })).msg.payload as any).title).toBe('Issue 2');
  });

  it('does not decide on stale data: a failed sync is a wait, not a pick', async () => {
    await issue(1, 10);
    syncResult.errors = ['Bad credentials'];

    const result = await tick();

    expect(result.output).toBe('busy');
    expect(result.msg.payload).toMatchObject({ reason: 'sync_failed' });
    expect((await AgentTask.findOne({ where: { externalId: 'gh-1-1' } }))!.workflowStatus).toBeNull();
  });

  it('skips the sync when told to', async () => {
    await issue(1, 10);
    await tick({ syncFirst: false });
    expect(GitSyncService.syncProject).not.toHaveBeenCalled();
  });

  it('treats a task with no tracker by its local lifecycle', () => {
    expect(taskClosed({ externalStatus: null, status: 'done' } as any)).toBe(true);
    expect(taskClosed({ externalStatus: null, status: 'failed' } as any)).toBe(false);
    expect(taskClosed({ externalStatus: 'open', status: 'done' } as any)).toBe(false);
    expect(taskClosed({ externalStatus: 'CLOSED', status: 'new' } as any)).toBe(true);
  });
});
