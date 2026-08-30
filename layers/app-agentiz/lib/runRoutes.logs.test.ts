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
import { runRoutes } from './runRoutes';

/**
 * The contract the run screen polls against: open a run and you get the *newest* lines, each tick
 * asks for what came after the cursor it was given, and the beginning is fetched on demand. What
 * this guards is the failure it was built for — a long run whose new lines stop appearing because
 * a fixed limit was already spent on the beginning of the log.
 */
describe('run routes: log paging', () => {
  let sequelize: Sequelize;
  let runId = '';
  const OWNER = 1;

  const handler = runRoutes.find((route) => route.route === '/agentiz-runs' && route.method === 'get')!.handler as any;

  /** Just enough of an Express response to read the status and body back off. */
  const response = () => {
    const sent: any = { code: 200 };
    sent.status = (code: number) => { sent.code = code; return sent; };
    sent.json = (body: any) => { sent.body = body; return sent; };
    return sent;
  };

  /**
   * The route checks the panel session and the project right itself (`adminizerMiddlewares` run
   * before Adminizer's policies), so the fake request carries the project's owner — the person
   * whose run this is.
   */
  const call = async (query: Record<string, string>) => {
    const sent = response();
    await handler({ query, session: { UserAP: { id: OWNER } }, user: { id: OWNER } }, sent);
    return sent;
  };

  const messages = (sent: any) => sent.body.data.logs.map((log: any) => log.message);

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

  const writeLog = (message: string, at: number) => AgentRunLog.create(
    { runId, level: 'debug', message, createdAt: new Date(at), updatedAt: new Date(at) } as any,
    { silent: true },
  );

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    const project = await AgentProject.create({ name: 'Logs', slug: 'logs', ownerId: OWNER } as any);
    const task = await AgentTask.create({
      projectId: project.id, externalId: 'local:1', title: 'Task', status: 'in_progress', priority: 'normal',
    } as any);
    const run = await AgentRun.create({
      projectId: project.id, taskId: task.id, pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
      status: 'running', trigger: 'manual', currentStageIndex: 0,
    } as any);
    runId = run.id;
    for (let index = 0; index < 5; index += 1) await writeLog(`tool ${index}`, 1_700_000_000_000 + index * 1_000);
  });

  it('opens on the tail and then serves only what arrived since', async () => {
    const opened = await call({ _method: 'getRunDetails', runId, logLimit: '3' });
    expect(messages(opened)).toEqual(['tool 2', 'tool 3', 'tool 4']);
    expect(opened.body.data.logsHasEarlier).toBe(true);

    await writeLog('tool 5', 1_700_000_005_000);
    const tick = await call({ _method: 'getRunDetails', runId, logsAfter: opened.body.data.logsCursor });
    expect(messages(tick)).toEqual(['tool 5']);

    // Nothing new: an empty page and no cursor, so the screen keeps the position it had.
    const quiet = await call({ _method: 'getRunDetails', runId, logsAfter: tick.body.data.logsCursor });
    expect(messages(quiet)).toEqual([]);
    expect(quiet.body.data.logsCursor).toBeNull();
  });

  it('walks back towards the start without the rest of the payload', async () => {
    const opened = await call({ _method: 'getRunDetails', runId, logLimit: '3' });
    const earlier = await call({ _method: 'getRunLogs', runId, before: opened.body.data.logsEarlierCursor, limit: '2' });
    expect(messages(earlier)).toEqual(['tool 0', 'tool 1']);
    expect(earlier.body.data.logsHasEarlier).toBe(false);
    // The patch is the reason this endpoint exists — it must not be in the answer.
    expect(earlier.body.data.diff).toBeUndefined();
  });

  it('answers a malformed cursor with 400 rather than silently restarting the log', async () => {
    const bad = await call({ _method: 'getRunLogs', runId, after: 'garbage' });
    expect(bad.code).toBe(400);
    expect(bad.body.message).toContain('not a run log cursor');
  });
});
