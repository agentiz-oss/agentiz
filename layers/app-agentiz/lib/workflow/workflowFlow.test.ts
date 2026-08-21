import { EventEmitter } from 'events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { Sequelize } from 'sequelize-typescript';
import {
  InMemoryDataStore,
  WorkflowEngine,
  nodeRegistry,
  workflowEngineHolder,
} from '@nodeknit/app-workflow';
import type { WorkflowEventBus } from '@nodeknit/app-workflow';
import * as agentizModels from '../../models';
import { AgentProject } from '../../models/AgentProject';
import { AgentRun } from '../../models/AgentRun';
import { AgentTask } from '../../models/AgentTask';
import { AgentWorkflowRun } from '../../models/AgentWorkflowRun';
import { AgentWorkflowSpec } from '../../models/AgentWorkflowSpec';
import { AgentPipelineService } from '../../services/AgentPipelineService';
import { agentizWorkflowMcpTools } from '../../mcp/agentizWorkflowTools';
import { AgentizWorkflowHost } from './host';
import { AgentizWorkflowSpecProvider } from './specProvider';
import { agentizWorkflowNodes, taskMatchNode, taskRunNode } from './nodes';
import { AgentizWorkflowRunStore } from './runStore';
import { forgetWorkflowEvents, useWorkflowEvents } from './events';

/** The engine walks a graph out of band; give it a moment before reading the run record. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 40));

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** A NodeContext good enough to call one executor by hand. */
function nodeContext(payload: Record<string, unknown>, config: Record<string, unknown>): any {
  return {
    msg: { payload },
    config,
    specId: 's', runId: 'r', nodeId: 'n',
    logger: silentLogger,
    store: {
      get: (): Promise<unknown> => Promise.resolve(undefined),
      set: (): Promise<void> => Promise.resolve(),
    },
    emit: () => {},
    host: new AgentizWorkflowHost(),
  };
}

function busOver(emitter: EventEmitter): WorkflowEventBus {
  return {
    emit: (key, payload) => { emitter.emit(key, payload); },
    on: (key, listener) => { emitter.on(key, listener); return () => { emitter.off(key, listener); }; },
    catalog: () => [],
  };
}


/** Call an MCP tool the way the endpoint does: by name, with a plain params object. */
function callTool(name: string, params: Record<string, unknown> = {}): Promise<any> {
  const tool = agentizWorkflowMcpTools.find((item) => item.name === name);
  if (!tool) throw new Error(`No such tool: ${name}`);
  return Promise.resolve(tool.handler!(params, {} as any));
}

/** trigger → «выполни» или тег todo → (match) запустить пайплайн. */
const FLOW = {
  nodes: [
    { id: 'arrived', type: 'agentiz.task.trigger', config: { event: 'agentiz.task.created' } },
    { id: 'worth', type: 'agentiz.task.match', config: { keywords: 'выполни', tags: 'todo' } },
    { id: 'run', type: 'agentiz.task.run', config: {} },
  ],
  edges: [
    { from: 'arrived', to: 'worth' },
    { from: 'worth', fromPort: 'match', to: 'run' },
  ],
};

describe('agentiz workflow nodes', () => {
  let sequelize: Sequelize;
  let engine: WorkflowEngine;
  let emitter: EventEmitter;
  let runStore: AgentizWorkflowRunStore;
  let projectId: string;
  const started: string[] = [];
  /** Ids of the AgentRun rows the mocked `runTask` produced, newest last. */
  const pipelineRuns: string[] = [];

  beforeAll(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, models: Object.values(agentizModels) as any[] });
    for (const node of agentizWorkflowNodes) nodeRegistry.register(node);
    // The one thing a test must not do for real: queue a pipeline. Everything up to the decision
    // is exercised; what happens after `runTask` is AgentPipelineService's own tested territory.
    vi.spyOn(taskRunNode.executor!, 'execute').mockImplementation(async (ctx) => {
      started.push(String((ctx.msg.payload as { taskId?: string })?.taskId));
      return { msg: ctx.msg };
    });
    // `agentiz.pipeline` does start a real run — it needs one, because the continuation comes from
    // the AgentRun hook. Only the queueing of a worker job is replaced.
    vi.spyOn(AgentPipelineService, 'runTask').mockImplementation(async (taskId: string) => {
      const task = await AgentTask.findByPk(taskId);
      const run = await AgentRun.create({
        taskId, projectId: task!.projectId, status: 'running', trigger: 'sync', currentStageIndex: 0,
        pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
      } as any);
      pipelineRuns.push(run.id);
      return run;
    });
  });

  afterAll(async () => {
    for (const node of agentizWorkflowNodes) nodeRegistry.unregister(node.type);
    await sequelize.close();
  });

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    started.length = 0;
    pipelineRuns.length = 0;
    emitter = new EventEmitter();
    runStore = new AgentizWorkflowRunStore();
    engine = new WorkflowEngine({
      registry: nodeRegistry,
      runStore,
      dataStore: new InMemoryDataStore(),
      eventBus: busOver(emitter),
      host: new AgentizWorkflowHost(),
      logger: silentLogger,
    });
    engine.addSpecProvider(new AgentizWorkflowSpecProvider());
    // The AgentRun hook and the MCP tools reach the engine through this holder, exactly as they do
    // at runtime once AppWorkflow.mount() has attached it.
    workflowEngineHolder().attach(engine);
    useWorkflowEvents({ emitter });

    projectId = (await AgentProject.create({ name: 'P', slug: 'p', ownerId: 1 } as any)).id;
    await AgentWorkflowSpec.create({ name: 'Автозапуск', active: true, version: 1, spec: FLOW, projectId } as any);
    await engine.rebindTriggers();
  });

  afterEach(async () => {
    forgetWorkflowEvents();
    workflowEngineHolder().detach();
    await engine.stop();
  });

  it('creating a task with "выполни" in the title walks the flow to the pipeline node', async () => {
    await AgentTask.create({ projectId, externalId: 'local:1', title: 'Выполни рефакторинг логина', status: 'new', priority: 'normal' } as any);
    await settled();

    expect(started).toHaveLength(1);
  });

  it('a task tagged todo is started too', async () => {
    await AgentTask.create({ projectId, externalId: 'local:2', title: 'Просто мысль', tags: ['TODO'], status: 'new', priority: 'normal' } as any);
    await settled();

    expect(started).toHaveLength(1);
  });

  it('an ordinary task is not started', async () => {
    await AgentTask.create({ projectId, externalId: 'local:3', title: 'Обсудить архитектуру', status: 'new', priority: 'normal' } as any);
    await settled();

    expect(started).toHaveLength(0);
  });

  it('an inactive flow does not fire at all', async () => {
    await AgentWorkflowSpec.update({ active: false }, { where: {} });
    await engine.rebindTriggers();

    await AgentTask.create({ projectId, externalId: 'local:4', title: 'Выполни это', status: 'new', priority: 'normal' } as any);
    await settled();

    expect(started).toHaveLength(0);
  });

  it('a status change does not wake the flow, an edited title does', async () => {
    const task = await AgentTask.create({ projectId, externalId: 'local:5', title: 'Обсудить', status: 'new', priority: 'normal' } as any);
    await settled();
    started.length = 0;

    await task.update({ status: 'done' });
    await settled();
    expect(started).toHaveLength(0);

    // The flow above listens to `task.created` only, so an edit must not reach it either — what is
    // asserted here is that the *event* is emitted for a watched field and not for a status move.
    const updates: unknown[] = [];
    emitter.on('agentiz.task.updated', (payload) => updates.push(payload));
    await task.update({ title: 'Выполни это' });
    await settled();
    expect(updates).toHaveLength(1);
  });


  it('an "выполни" task walks trigger → match → pipeline and parks until the run finishes', async () => {
    // A flow whose decision leads into the waiting pipeline node, and whose `succeeded` port leads
    // into the (mocked) fire-and-forget node so the continuation is observable.
    await AgentWorkflowSpec.update({
      spec: {
        nodes: [
          { id: 'arrived', type: 'agentiz.task.trigger', config: { event: 'agentiz.task.created' } },
          { id: 'worth', type: 'agentiz.task.match', config: { keywords: 'выполни', tags: 'todo' } },
          { id: 'pipe', type: 'agentiz.pipeline', config: {} },
          { id: 'after', type: 'agentiz.task.run', config: {} },
        ],
        edges: [
          { from: 'arrived', to: 'worth' },
          { from: 'worth', fromPort: 'match', to: 'pipe' },
          { from: 'pipe', fromPort: 'succeeded', to: 'after' },
        ],
      },
    }, { where: {} });
    await engine.rebindTriggers();

    const task = await AgentTask.create({ projectId, externalId: 'local:6', title: 'Выполни задачу', status: 'new', priority: 'normal' } as any);
    await settled();

    // Parked, and parked *durably*: the row is what lets the finished pipeline find this flow
    // again after a restart.
    const parked = (await runStore.listActive()).at(0)!;
    expect(parked.status).toBe('waiting_external');
    expect(parked.externalRef).toBe(`run:${pipelineRuns[0]}`);
    expect(await AgentWorkflowRun.count({ where: { status: 'waiting_external' } })).toBe(1);
    expect(started).toHaveLength(0);

    // The pipeline finishes; the AgentRun hook hands the outcome back to the engine.
    const run = await AgentRun.findByPk(pipelineRuns[0]);
    await run!.update({ status: 'succeeded', resultSummary: 'готово' });
    await settled();

    expect(started).toEqual([task.id]);
    const finished = await AgentWorkflowRun.findByPk(parked.id);
    expect(finished!.status).toBe('succeeded');
  });

  it('a failed pipeline is a result, not a broken flow: the "failed" port is taken', async () => {
    await AgentWorkflowSpec.update({
      spec: {
        nodes: [
          { id: 'arrived', type: 'agentiz.task.trigger', config: { event: 'agentiz.task.created' } },
          { id: 'pipe', type: 'agentiz.pipeline', config: {} },
          { id: 'after', type: 'agentiz.task.run', config: {} },
        ],
        edges: [
          { from: 'arrived', to: 'pipe' },
          { from: 'pipe', fromPort: 'failed', to: 'after' },
        ],
      },
    }, { where: {} });
    await engine.rebindTriggers();

    await AgentTask.create({ projectId, externalId: 'local:7', title: 'Что угодно', status: 'new', priority: 'normal' } as any);
    await settled();

    const run = await AgentRun.findByPk(pipelineRuns[0]);
    await run!.update({ status: 'failed', errorMessage: 'воркер умер' });
    await settled();

    expect(started).toHaveLength(1);
    const workflowRun = (await AgentWorkflowRun.findAll()).at(0)!;
    expect(workflowRun.status).toBe('succeeded');
    expect((workflowRun.msg as any).payload.error).toBe('воркер умер');
  });

  it('the match node takes the "no" branch and reports what it looked at', async () => {
    const result = await taskMatchNode.executor!.execute(
      nodeContext({ taskId: 't1', title: 'Обсудить', description: null, tags: [] }, { keywords: 'выполни', tags: 'todo' }),
    );

    expect('msg' in result && result.output).toBe('no');
    expect('msg' in result && (result.msg.payload as any).match).toEqual({ matched: false, keywords: [], tags: [] });
  });

  it('an empty check matches nothing rather than everything', async () => {
    const result = await taskMatchNode.executor!.execute(
      nodeContext({ taskId: 't1', title: 'Выполни', description: null, tags: ['todo'] }, {}),
    );

    expect('msg' in result && result.output).toBe('no');
  });

  describe('MCP tools', () => {
    it('lists the workflow and describes the palette an agent has to write against', async () => {
      const list = await callTool('agentiz.workflows');
      expect(list.count).toBe(1);
      expect(list.items[0]).toMatchObject({ providerId: 'agentiz', name: 'Автозапуск', active: true, canEdit: true });

      const schema = await callTool('agentiz.workflowSchema');
      const pipeline = schema.nodeTypes.find((type: any) => type.type === 'agentiz.pipeline');
      expect(pipeline.ports).toEqual({ inputs: 1, outputs: ['succeeded', 'failed'] });
      // The executor must never cross this boundary — a palette entry is schema and ports only.
      expect(pipeline.external).toBeUndefined();
    });

    it('refuses an invalid graph with the offending node in the message', async () => {
      const specId = (await AgentWorkflowSpec.findOne())!.id;
      await expect(callTool('agentiz.manageWorkflow', {
        action: 'save',
        spec: { id: specId, name: 'Сломанный', nodes: [{ id: 'x', type: 'no.such.node' }], edges: [] },
      })).rejects.toThrow(/\[x\].*no\.such\.node/);
    });

    it('activate goes through validation, so an unfinished graph cannot be armed', async () => {
      const specId = (await AgentWorkflowSpec.findOne())!.id;
      await callTool('agentiz.manageWorkflow', { action: 'deactivate', specId });
      expect((await AgentWorkflowSpec.findByPk(specId))!.active).toBe(false);

      await AgentTask.create({ projectId, externalId: 'local:8', title: 'Выполни это', status: 'new', priority: 'normal' } as any);
      await settled();
      expect(started).toHaveLength(0);

      await callTool('agentiz.manageWorkflow', { action: 'activate', specId });
      expect((await AgentWorkflowSpec.findByPk(specId))!.active).toBe(true);
    });

    it('fires one trigger node by hand and refuses anything that is not one', async () => {
      const specId = (await AgentWorkflowSpec.findOne())!.id;
      const task = await AgentTask.create({ projectId, externalId: 'local:9', title: 'Обычная', status: 'new', priority: 'normal' } as any);
      await settled();
      started.length = 0;

      await expect(callTool('agentiz.fireWorkflowTrigger', { specId, nodeId: 'worth' }))
        .rejects.toThrow(/not a trigger node/);

      // Injecting a msg is how a flow is debugged without waiting for a real task to arrive.
      const { run } = await callTool('agentiz.fireWorkflowTrigger', {
        specId, nodeId: 'arrived',
        msg: { payload: { taskId: task.id, projectId, title: 'Выполни', description: null, tags: [] } },
      });
      await settled();

      expect(run.trigger).toBe('arrived');
      expect(started).toEqual([task.id]);
    });
  });
});
