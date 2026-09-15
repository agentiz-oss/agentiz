import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../models';
import { AgentProject } from '../models/AgentProject';
import { AgentRun } from '../models/AgentRun';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentTask } from '../models/AgentTask';
import { AgentWorker } from '../models/AgentWorker';
import { PipelineSpec } from '../models/PipelineSpec';
import { listRuns } from './runBoard';

/**
 * The board behind both run lists. Three things are pinned here and each of them is a way the
 * screen silently lies otherwise: the scope it may read, the fact that the status filter is the
 * server's job, and that a row carries what an address is built from.
 */
describe('listRuns', () => {
  let sequelize: Sequelize;
  let mine: AgentProject;
  let theirs: AgentProject;
  let spec: PipelineSpec;

  async function makeRun(project: AgentProject, status: string, over: Record<string, unknown> = {}) {
    const task = await AgentTask.create({
      projectId: project.id, externalId: `local:${Math.random()}`, title: 'Задача', status: 'new', priority: 'normal',
    } as any);
    return AgentRun.create({
      projectId: project.id, taskId: task.id, status, trigger: 'manual', currentStageIndex: 0,
      pipelineSpecId: spec.id, pipelineSnapshot: { stages: [], finalAction: { type: 'none' } }, ...over,
    } as any);
  }

  beforeEach(async () => {
    sequelize = new Sequelize({
      dialect: 'sqlite', storage: ':memory:', logging: false,
      models: Object.values(agentizModels) as any[],
    });
    await sequelize.sync({ force: true });
    mine = await AgentProject.create({ name: 'Мой', slug: 'mine', ownerId: 1 } as any);
    theirs = await AgentProject.create({ name: 'Чужой', slug: 'theirs', ownerId: 2 } as any);
    spec = await PipelineSpec.create({
      projectId: mine.id,
      name: 'Основной',
      spec: { stages: [{ order: 1, role: 'dev', agentRoleKey: 'dev', runtime: { mode: 'host' } }], finalAction: { type: 'none' } },
    } as any);
  });

  it('reads only the projects it was given', async () => {
    await makeRun(mine, 'running');
    await makeRun(theirs, 'running');

    // The global board. `adminizerMiddlewares` mount before Adminizer's policies and this query
    // bypasses the access graph entirely, so the id list is the whole scoping there is.
    const visible = await listRuns('', [mine.id]);
    expect(visible.active).toHaveLength(1);
    expect(visible.active[0].project?.slug).toBe('mine');
    expect(visible.total).toBe(1);

    // And one project, the way the project board asks.
    expect((await listRuns(theirs.id)).active).toHaveLength(1);
  });

  it('splits in flight from finished, and caps the finished half — unchanged without a filter', async () => {
    await makeRun(mine, 'running');
    await makeRun(mine, 'waiting_input');
    await makeRun(mine, 'pending');
    for (let i = 0; i < 30; i += 1) await makeRun(mine, 'succeeded');

    const board = await listRuns(mine.id);

    expect(board.active).toHaveLength(3);
    expect(board.recent).toHaveLength(25);
    // `total` counts everything in scope, so «25 показано» never reads as «25 всего».
    expect(board.total).toBe(33);
  });

  it('finds a failure the browser could not have found', async () => {
    // The failure is older than the 25 finished runs the unfiltered board returns — which is the
    // whole reason the filter is applied in SQL instead of over the loaded rows.
    const old = await makeRun(mine, 'failed', { errorMessage: 'boom' });
    for (let i = 0; i < 30; i += 1) await makeRun(mine, 'succeeded');

    expect((await listRuns(mine.id)).recent.some((run) => run.id === old.id)).toBe(false);

    const failures = await listRuns(mine.id, undefined, 'failed');
    expect(failures.recent.map((run) => run.id)).toEqual([old.id]);
    // A terminal filter leaves the live half empty rather than ignoring the filter there.
    expect(failures.active).toEqual([]);
    expect(failures.total).toBe(31);
  });

  it('filters the live half too', async () => {
    await makeRun(mine, 'running');
    await makeRun(mine, 'waiting_input');

    const waiting = await listRuns(mine.id, undefined, 'waiting_input');
    expect(waiting.active).toHaveLength(1);
    expect(waiting.recent).toEqual([]);
  });

  it('carries what a link and a row are built from', async () => {
    const worker = await AgentWorker.create({ name: 'wrk-1', tokenHash: 'x', status: 'active' } as any);
    const run = await makeRun(mine, 'succeeded', { branch: 'agentiz/task-7' });
    await AgentRunJob.create({
      runId: run.id, projectId: mine.id, status: 'succeeded', workerId: worker.id, snapshot: {},
    } as any);

    const [card] = (await listRuns(mine.id)).recent;
    // The slug: a row that carried only the project id would put address-building back into the
    // module, and `routeTree.href` is the one place allowed to spell an address.
    expect(card.project).toEqual({ id: mine.id, name: 'Мой', slug: 'mine' });
    expect(card.pipeline).toEqual({ id: spec.id, name: 'Основной' });
    expect(card.branch).toBe('agentiz/task-7');
    expect(card.job?.worker?.name).toBe('wrk-1');
  });
});
