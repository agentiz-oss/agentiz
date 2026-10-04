import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { Sequelize } from 'sequelize-typescript';
import type { NodeContext, WorkflowMsg } from '@nodeknit/app-workflow';
import * as agentizModels from '../../models';
import { AgentActivity } from '../../models/AgentActivity';
import { AgentProject } from '../../models/AgentProject';
import { AgentTask } from '../../models/AgentTask';
import { registerActivityNotifier, unregisterActivityNotifier, type ActivityEvent } from '../activityNotifiers';
import { notifyNode } from './nodes';

/**
 * `agentiz.notify` is the one way a graph reaches a person, and it is worth exactly two promises:
 * it goes through the dispatcher — so the feed row exists and the policy still decides — and it
 * wakes the phone by default, which is the whole reason somebody put it after a filtered trigger.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function context(config: Record<string, unknown>, msg: WorkflowMsg = {}): NodeContext {
  return {
    msg,
    config,
    specId: 'spec-1',
    runId: 'run-1',
    nodeId: 'notify',
    logger: silentLogger,
    store: { get: async () => undefined, set: async () => {} },
    emit: () => {},
    host: {
      checkPermission: async () => true,
      resolveSecret: async () => undefined,
      notify: async () => {},
      now: () => new Date(),
    },
  };
}

/** What the package trigger puts into `msg.payload` for `restoapp:next`. */
function packagePayload(projectId: string): Record<string, unknown> {
  return {
    projectId,
    repositoryId: 'repo-1',
    pathWithNamespace: 'webresto/restoapp',
    packageName: 'restoapp',
    packageType: 'container',
    action: 'published',
    tag: 'next',
    digest: 'sha256:abc',
    htmlUrl: 'https://github.com/webresto/restoapp/pkgs/container/restoapp/1',
  };
}

describe('agentiz.notify', () => {
  let sequelize: Sequelize;
  let projectId: string;
  const delivered: ActivityEvent[] = [];

  beforeAll(async () => {
    sequelize = new Sequelize({
      dialect: 'sqlite',
      storage: ':memory:',
      logging: false,
      models: Object.values(agentizModels) as any[],
    });
    registerActivityNotifier({ id: 'test:capture', channel: 'push', notify: async (event) => { delivered.push(event); } });
  });

  afterAll(async () => {
    unregisterActivityNotifier('test:capture');
    await sequelize.close();
  });

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    projectId = (await AgentProject.create({ slug: 'restoapp', name: 'restoapp', ownerId: 1 } as any)).id;
  });

  afterEach(() => {
    delivered.length = 0;
  });

  it('пишет строку в ленту и отдаёт её диспетчеру с пушем со звуком', async () => {
    const result = await notifyNode.executor!.execute(context(
      { title: 'Вышел {{payload.packageName}}:{{payload.tag}}', body: '{{payload.htmlUrl}}' },
      { payload: packagePayload(projectId) },
    ));

    const rows = await AgentActivity.findAll({ where: { type: 'workflow.notify' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].projectId).toBe(projectId);
    expect(rows[0].title).toBe('Вышел restoapp:next');
    expect(rows[0].body).toBe('https://github.com/webresto/restoapp/pkgs/container/restoapp/1');
    expect(rows[0].taskId).toBeNull();
    expect(rows[0].data).toMatchObject({ workflowSpecId: 'spec-1', workflowRunId: 'run-1', nodeId: 'notify' });

    expect(delivered).toHaveLength(1);
    expect(delivered[0].delivery.push).toBe('on');
    expect(delivered[0].context.recipientIds).toContain(1);

    // Pass-through: whatever comes next still reads the package fields.
    expect((result as any).msg.payload).toMatchObject({ ...packagePayload(projectId), activityId: rows[0].id });
  });

  it('привязывает уведомление к задаче, если она есть в payload', async () => {
    const task = await AgentTask.create({
      projectId,
      externalId: 'local:image',
      title: 'Новый образ restoapp:next',
      status: 'new',
    } as any);

    await notifyNode.executor!.execute(context(
      { title: 'Вышел next' },
      { payload: { ...packagePayload(projectId), taskId: task.id } },
    ));

    const row = await AgentActivity.findOne({ where: { type: 'workflow.notify' } });
    expect(row?.taskId).toBe(task.id);
    expect(delivered[0].context.taskTitle).toBe('Новый образ restoapp:next');
  });

  it('проект из конфига важнее проекта из payload', async () => {
    const other = (await AgentProject.create({ slug: 'other', name: 'other', ownerId: 1 } as any)).id;
    await notifyNode.executor!.execute(context({ projectId: other, title: 'x' }, { payload: packagePayload(projectId) }));
    const row = await AgentActivity.findOne({ where: { type: 'workflow.notify' } });
    expect(row?.projectId).toBe(other);
  });

  it('пустой заголовок — ошибка ноды, а не пустой пуш', async () => {
    await expect(notifyNode.executor!.execute(context(
      { title: '{{payload.nothing}}' },
      { payload: packagePayload(projectId) },
    ))).rejects.toThrow(/заголовок пуст/);
    expect(await AgentActivity.count()).toBe(0);
    expect(delivered).toHaveLength(0);
  });

  it('без проекта — ошибка, а не тихое молчание', async () => {
    await expect(notifyNode.executor!.execute(context({ title: 'x' }, { payload: {} })))
      .rejects.toThrow(/не указан проект/);
  });

  it('несуществующий проект — ошибка ноды, раз событие не родилось', async () => {
    await expect(notifyNode.executor!.execute(context({ projectId: 'missing', title: 'x' })))
      .rejects.toThrow(/событие не записано/);
  });
});
