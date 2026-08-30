import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { Sequelize } from 'sequelize-typescript';
import type { NodeContext, NodeResult, WorkflowMsg } from '@nodeknit/app-workflow';
import * as agentizModels from '../../models';
import { AgentProject } from '../../models/AgentProject';
import { AgentTask } from '../../models/AgentTask';
import { AgentWorkspaceProposal } from '../../models/AgentWorkspaceProposal';
import { taskCreateNode, tasksQueryNode } from './nodes';

/**
 * The two nodes a release flow is built from, tested as the units they are.
 *
 * The end-to-end round with a person lives in `humanInTheLoop.test.ts`; what is worth pinning down
 * here is narrower and easier to get wrong later: **what counts as ready**, and what the release
 * task carries away from the count. Both are decisions a reader cannot recover from the schema —
 * "принято" is a text somebody typed into a node, and "готово" additionally means a branch exists.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function context(config: Record<string, unknown>, msg: WorkflowMsg = {}): NodeContext {
  return {
    msg,
    config,
    specId: 'spec-1',
    runId: 'run-1',
    nodeId: 'node-1',
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

const ACCEPTED = 'Принято';

describe('релизная очередь: сколько накопилось и что уходит в сборку', () => {
  let sequelize: Sequelize;
  let projectId: string;

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
    const project = await AgentProject.create({ slug: 'lyapka', name: 'lyapka', isActive: true } as any);
    projectId = project.id;
  });

  /** A task in whatever state the test needs, optionally with a branch that reached the remote. */
  async function feature(
    title: string,
    options: { workflowStatus?: string | null; branch?: string | null; proposalStatus?: string; acceptedAt?: Date } = {},
  ): Promise<AgentTask> {
    const task = await AgentTask.create({
      projectId,
      externalId: `local:${title}`,
      title,
      status: 'done',
      workflowStatus: options.workflowStatus === undefined ? ACCEPTED : options.workflowStatus,
      workflowStatusAt: options.acceptedAt ?? new Date(),
      tags: [],
    } as any);
    if (options.branch) {
      await AgentWorkspaceProposal.create({
        projectId,
        taskId: task.id,
        initialRunId: 'r',
        latestRunId: 'r',
        workerId: 'worker-1',
        workspaceKey: 'lyapka',
        workspacePath: '/prj/lyapka-rf',
        targetMode: 'new',
        remote: 'origin',
        targetBranch: options.branch,
        commitMessage: title,
        status: options.proposalStatus ?? 'pushed',
      } as any);
    }
    return task;
  }

  async function count(config: Record<string, unknown> = {}): Promise<NodeResult> {
    return tasksQueryNode.executor!.execute(
      context({ projectId, workflowStatus: ACCEPTED, ...config }),
    );
  }

  it('берёт только задачи с нужным статусом и запушенной веткой', async () => {
    await feature('одна', { branch: 'agentiz/one' });
    await feature('две', { branch: 'agentiz/two' });
    await feature('три', { branch: 'agentiz/three' });
    // Приняты, но релизу не с чем работать — ни одна не должна попасть в счёт.
    await feature('без ветки', { branch: null });
    await feature('ветка на ревью', { branch: 'agentiz/held', proposalStatus: 'waiting_review' });
    // Ветка есть, но человек не принимал.
    await feature('не принята', { workflowStatus: 'На проверке', branch: 'agentiz/pending' });

    const result = (await count()) as { msg: WorkflowMsg; output?: string };
    expect(result.output).toBe('enough');
    const payload = result.msg.payload as any;
    expect(payload.count).toBe(3);
    expect(payload.branches).toEqual(['agentiz/one', 'agentiz/two', 'agentiz/three']);
    expect(payload.taskIds).toHaveLength(3);
  });

  it('«ещё не набралось» — обычный исход, а не ошибка', async () => {
    await feature('одна', { branch: 'agentiz/one' });
    await feature('две', { branch: 'agentiz/two' });

    const result = (await count()) as { msg: WorkflowMsg; output?: string };
    expect(result.output).toBe('notEnough');
    expect((result.msg.payload as any).count).toBe(2);
  });

  it('отдаёт самые давно принятые первыми — релиз разгружает очередь, а не снимает сливки', async () => {
    await feature('свежая', { branch: 'agentiz/new', acceptedAt: new Date('2026-08-30T10:00:00Z') });
    await feature('старая', { branch: 'agentiz/old', acceptedAt: new Date('2026-08-01T10:00:00Z') });
    await feature('средняя', { branch: 'agentiz/mid', acceptedAt: new Date('2026-08-15T10:00:00Z') });

    const result = (await count()) as { msg: WorkflowMsg };
    expect((result.msg.payload as any).branches).toEqual(['agentiz/old', 'agentiz/mid', 'agentiz/new']);
  });

  it('порог и потолок настраиваются', async () => {
    await feature('одна', { branch: 'agentiz/one' });
    await feature('две', { branch: 'agentiz/two' });

    expect(((await count({ minCount: 2 })) as any).output).toBe('enough');
    expect(((await count({ minCount: 5 })) as any).output).toBe('notEnough');
    const capped = (await count({ minCount: 1, limit: 1 })) as { msg: WorkflowMsg };
    expect((capped.msg.payload as any).count).toBe(1);
  });

  it('без проекта или без статуса не угадывает, а падает', async () => {
    await expect(tasksQueryNode.executor!.execute(context({ workflowStatus: ACCEPTED }))).rejects.toThrow(/проект/);
    await expect(tasksQueryNode.executor!.execute(context({ projectId }))).rejects.toThrow(/статус/);
  });

  it('релизная задача подменяет taskId и уносит список исходных', async () => {
    await feature('одна', { branch: 'agentiz/one' });
    await feature('две', { branch: 'agentiz/two' });
    await feature('три', { branch: 'agentiz/three' });
    const counted = (await count()) as { msg: WorkflowMsg };
    const sourceIds = (counted.msg.payload as any).taskIds;

    const created = (await taskCreateNode.executor!.execute(
      context(
        {
          title: 'Релиз: {{payload.count}} фич',
          description: 'Ветки: {{payload.branches}}',
          tags: 'релиз',
        },
        counted.msg,
      ),
    )) as { msg: WorkflowMsg };

    const payload = created.msg.payload as any;
    expect(payload.title).toBe('Релиз: 3 фич');
    expect(payload.taskId).not.toEqual(sourceIds[0]);
    expect(payload.releaseTaskId).toBe(payload.taskId);
    expect(payload.sourceTaskIds).toEqual(sourceIds);

    const task = await AgentTask.findByPk(payload.taskId);
    // The branch list has to reach the agent, and the description is what the prompt is built from.
    expect(task!.description).toContain('agentiz/one');
    expect(task!.description).toContain('agentiz/three');
    expect(task!.tags).toEqual(['релиз']);
  });

  it('без названия задачу не заводит', async () => {
    await expect(
      taskCreateNode.executor!.execute(context({ projectId, title: '  ' })),
    ).rejects.toThrow(/название/);
  });
});
