import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../models';
import { AgentProject } from '../models/AgentProject';
import { AgentRun } from '../models/AgentRun';
import { AgentRunLog } from '../models/AgentRunLog';
import { AgentTask } from '../models/AgentTask';
import { listRunLogs, runLogCursor } from './runLogs';

/**
 * Paging a run's log. The two properties that matter: a page without a cursor is the newest end
 * (a live run outgrows any limit, and the screen must not freeze at it), and following with
 * `after` never repeats or skips a line — including lines written inside the same millisecond,
 * which is the normal case for a batch of tool-call events.
 */
describe('listRunLogs', () => {
  let sequelize: Sequelize;
  let RUN = '';
  let OTHER_RUN = '';

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

  /** `createdAt` is set explicitly so the fixture controls ties instead of the clock. */
  const write = async (runId: string, message: string, createdAt: Date) =>
    AgentRunLog.create({ runId, level: 'info', message, createdAt, updatedAt: createdAt } as any, { silent: true });

  const messages = (page: { logs: AgentRunLog[] }) => page.logs.map((log) => log.message);

  /** Two runs of the same task, so "never crosses into another run" is a real scoping check. */
  const seedRuns = async () => {
    const project = await AgentProject.create({ name: 'Logs', slug: 'logs', ownerId: 1 } as any);
    const task = await AgentTask.create({
      projectId: project.id, externalId: 'local:1', title: 'Task', status: 'in_progress', priority: 'normal',
    } as any);
    const make = async () => (await AgentRun.create({
      projectId: project.id, taskId: task.id, pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
      status: 'running', trigger: 'manual', currentStageIndex: 0,
    } as any)).id;
    RUN = await make();
    OTHER_RUN = await make();
  };

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    await seedRuns();
    for (let index = 0; index < 10; index += 1) {
      await write(RUN, `line ${index}`, new Date(1_700_000_000_000 + index * 1_000));
    }
    await write(OTHER_RUN, 'other run', new Date(1_700_000_000_000));
  });

  it('returns the newest lines when no cursor is given', async () => {
    const page = await listRunLogs(RUN, { limit: 3 });
    expect(messages(page)).toEqual(['line 7', 'line 8', 'line 9']);
    expect(page.hasEarlier).toBe(true);
    expect(page.hasMore).toBe(false);
  });

  it('never crosses into another run', async () => {
    const page = await listRunLogs(OTHER_RUN, { limit: 50 });
    expect(messages(page)).toEqual(['other run']);
    expect(page.hasEarlier).toBe(false);
  });

  it('follows the tail with `after` without repeating a line', async () => {
    const first = await listRunLogs(RUN, { limit: 3 });
    await write(RUN, 'line 10', new Date(1_700_000_010_000));
    const next = await listRunLogs(RUN, { after: first.nextCursor, limit: 3 });
    expect(messages(next)).toEqual(['line 10']);
    expect(await listRunLogs(RUN, { after: next.nextCursor, limit: 3 }).then(messages)).toEqual([]);
  });

  it('reports that an `after` page was cut short so the caller asks again', async () => {
    const all = await listRunLogs(RUN, { limit: 50 });
    const fromStart = await listRunLogs(RUN, { after: runLogCursor(all.logs[0]), limit: 3 });
    expect(messages(fromStart)).toEqual(['line 1', 'line 2', 'line 3']);
    expect(fromStart.hasMore).toBe(true);
    expect((await listRunLogs(RUN, { after: runLogCursor(all.logs[6]), limit: 3 })).hasMore).toBe(false);
  });

  it('walks backwards with `before`, ending with an empty page', async () => {
    const tail = await listRunLogs(RUN, { limit: 4 });
    const earlier = await listRunLogs(RUN, { before: tail.earlierCursor, limit: 4 });
    expect(messages(earlier)).toEqual(['line 2', 'line 3', 'line 4', 'line 5']);
    expect(earlier.hasEarlier).toBe(true);
    const oldest = await listRunLogs(RUN, { before: earlier.earlierCursor, limit: 4 });
    expect(messages(oldest)).toEqual(['line 0', 'line 1']);
    expect(oldest.hasEarlier).toBe(false);
    expect(await listRunLogs(RUN, { before: oldest.earlierCursor, limit: 4 }).then(messages)).toEqual([]);
  });

  it('orders lines written in the same millisecond by id, in both directions', async () => {
    await sequelize.sync({ force: true });
    await seedRuns();
    const sameMoment = new Date(1_700_000_000_000);
    for (let index = 0; index < 6; index += 1) await write(RUN, `tool ${index}`, sameMoment);
    const all = await listRunLogs(RUN, { limit: 10 });
    const byId = [...all.logs].sort((left, right) => left.id.localeCompare(right.id)).map((log) => log.message);
    expect(messages(all)).toEqual(byId);

    // Every later line is reachable exactly once by following the cursor two at a time.
    const seen: string[] = [];
    let page = await listRunLogs(RUN, { after: runLogCursor(all.logs[0]), limit: 2 });
    while (page.logs.length > 0) {
      seen.push(...messages(page));
      page = await listRunLogs(RUN, { after: page.nextCursor, limit: 2 });
    }
    expect(seen).toEqual(byId.slice(1));
  });

  it('rejects a cursor that is not one', async () => {
    await expect(listRunLogs(RUN, { after: 'nonsense' })).rejects.toThrow('after is not a run log cursor');
    await expect(listRunLogs(RUN, { before: '|no-date' })).rejects.toThrow('before is not a run log cursor');
  });

  it('treats an empty cursor as "give me the tail"', async () => {
    expect(messages(await listRunLogs(RUN, { after: '', before: null, limit: 2 }))).toEqual(['line 8', 'line 9']);
  });
});
