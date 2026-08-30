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
  validateWorkflowSpec,
  workflowEngineHolder,
} from '@nodeknit/app-workflow';
import type { WorkflowEventBus } from '@nodeknit/app-workflow';
import * as agentizModels from '../../models';
import { AgentApprovalRequest } from '../../models/AgentApprovalRequest';
import { AgentProject } from '../../models/AgentProject';
import { AgentRun } from '../../models/AgentRun';
import { AgentTask } from '../../models/AgentTask';
import { AgentTaskComment } from '../../models/AgentTaskComment';
import { AgentWorkflowRun } from '../../models/AgentWorkflowRun';
import { AgentWorkflowSpec } from '../../models/AgentWorkflowSpec';
import { PipelineSpec } from '../../models/PipelineSpec';
import { AgentPipelineService } from '../../services/AgentPipelineService';
import { ApprovalService } from '../../services/ApprovalService';
import { registerActivityNotifier, unregisterActivityNotifier } from '../activityNotifiers';
import type { ActivityEvent } from '../activityNotifiers';
import { AgentizWorkflowHost } from './host';
import { AgentizWorkflowSpecProvider } from './specProvider';
import { agentizWorkflowNodes } from './nodes';
import { AgentizWorkflowRunStore } from './runStore';
import { forgetWorkflowEvents, useWorkflowEvents } from './events';

/**
 * The whole scenario of `.ai-notes/human-in-the-loop-workflow-plan.md`, end to end, in memory:
 *
 *   задача с тегом → разработчик → агент-тестировщик → (fail ⇒ замечания ⇒ новый круг)
 *                                                    → (pass ⇒ заявка человеку)
 *                                  человек: отклонил ⇒ замечания ⇒ новый круг
 *                                           принял   ⇒ задача принята, флоу закончилось
 *
 * What it is actually asserting, and why each of these is worth a test rather than a reading of
 * the code:
 *
 * - the loop **closes by itself**. The graph is acyclic and has two inputs; the round-ending
 *   comment is what raises the second one. Nothing in the graph says so, so only a run proves it.
 * - the loop **stops**. Three separate things could make it never stop — a run's own report in the
 *   thread, a status note, and an unbounded number of rounds — and each is checked here.
 * - a person is **told**, in both outcomes. The delivery goes through `ActivityService` and the
 *   `activityNotifiers` collection, so the test registers a notifier and reads what a phone would
 *   have received.
 * - a legacy graph is **unchanged**. `agentiz.task.trigger` and `agentiz.pipeline` both grew
 *   config; a spec saved before that must resolve its pipeline by tags and must not inherit the
 *   comment input's strict defaults.
 */

/** The engine walks a graph out of band, and one round now touches half a dozen tables. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 250));

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function busOver(emitter: EventEmitter): WorkflowEventBus {
  return {
    emit: (key, payload) => { emitter.emit(key, payload); },
    on: (key, listener) => { emitter.on(key, listener); return () => { emitter.off(key, listener); }; },
    catalog: () => [],
  };
}

/**
 * The reference graph, exactly as an operator would draw it.
 *
 * Two inputs converging on one chain (fan-in), and both failure branches converging on one comment
 * node — the second fan-in. `remark` therefore has three incoming edges and one outgoing, and in
 * any single run exactly one path is alive.
 */
function referenceFlow(devSpecId: string, qaSpecId: string) {
  return {
    nodes: [
      { id: 'arrived', type: 'agentiz.task.trigger', config: { event: 'agentiz.task.created' } },
      {
        id: 'commented',
        type: 'agentiz.task.trigger',
        // `agent` is in the list on purpose: the round-ending remark below is written by the flow
        // itself, and with the default (`human` only) the loop would wait for a live person.
        config: { event: 'agentiz.task.commented', authorKind: 'human, agent', maxRounds: 3 },
      },
      { id: 'worth', type: 'agentiz.task.match', config: { tags: 'фича' } },
      { id: 'toDev', type: 'agentiz.task.status', config: { text: 'В разработке' } },
      { id: 'dev', type: 'agentiz.pipeline', config: { specId: devSpecId } },
      { id: 'toQa', type: 'agentiz.task.status', config: { text: 'На проверке' } },
      { id: 'qa', type: 'agentiz.pipeline', config: { specId: qaSpecId } },
      { id: 'toHuman', type: 'agentiz.task.status', config: { text: 'Ждём человека' } },
      {
        id: 'gate',
        type: 'agentiz.approval',
        config: { title: 'Примите работу: {{payload.taskId}}', message: 'Вердикт агента: {{payload.verdict}}' },
      },
      { id: 'accepted', type: 'agentiz.task.status', config: { text: 'Принято' } },
      { id: 'remark', type: 'agentiz.task.comment', config: { body: 'Замечания: {{payload.verdictReason}}{{payload.comment}}{{payload.error}}' } },
    ],
    edges: [
      { from: 'arrived', to: 'worth' },
      // Both inputs converge here — the whole point of allowing fan-in.
      { from: 'commented', to: 'worth' },
      { from: 'worth', fromPort: 'match', to: 'toDev' },
      { from: 'toDev', to: 'dev' },
      { from: 'dev', fromPort: 'succeeded', to: 'toQa' },
      { from: 'toQa', to: 'qa' },
      { from: 'qa', fromPort: 'pass', to: 'toHuman' },
      { from: 'toHuman', to: 'gate' },
      { from: 'gate', fromPort: 'approved', to: 'accepted' },
      // …and both ways of saying "не годится" converge on one remark node.
      { from: 'qa', fromPort: 'fail', to: 'remark' },
      { from: 'gate', fromPort: 'rejected', to: 'remark' },
    ],
  };
}

const STAGE = { order: 1, role: 'dev', agentRoleKey: 'dev', runtime: { mode: 'host' } };
const DEV_SPEC = { stages: [STAGE], finalAction: { type: 'none' } };
// The qa stage is the one that asks for a machine verdict — that is what puts the flow on the
// `pass`/`fail` ports instead of `succeeded`.
const QA_SPEC = { stages: [{ ...STAGE, role: 'qa', agentRoleKey: 'qa', verdict: true }], finalAction: { type: 'none' } };

describe('human-in-the-loop: разработчик → тестировщик → человек', () => {
  let sequelize: Sequelize;
  let engine: WorkflowEngine;
  let emitter: EventEmitter;
  let runStore: AgentizWorkflowRunStore;
  let projectId: string;
  let devSpecId: string;
  let qaSpecId: string;
  /** Every pipeline run the flow started, in order, with the spec it was told to use. */
  const launches: Array<{ runId: string; specId: string | null; triggerCommentId: string | null }> = [];
  /** What a phone would have received — the far end of ActivityService → activityNotifiers. */
  const delivered: ActivityEvent[] = [];

  beforeAll(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, models: Object.values(agentizModels) as any[] });
    for (const node of agentizWorkflowNodes) nodeRegistry.register(node);
    // The one thing a test must not do for real: queue a job on a worker. The AgentRun row is
    // real — the whole continuation hangs off its terminal hook — and so is the spec resolution,
    // which is exactly what `specId` is being tested for.
    vi.spyOn(AgentPipelineService, 'runTask').mockImplementation(async (taskId, trigger, options: any = {}) => {
      const run = await AgentPipelineService.createRun(taskId, trigger, options);
      await run.update({ status: 'running' });
      launches.push({
        runId: run.id,
        specId: run.pipelineSpecId ?? null,
        triggerCommentId: run.triggerCommentId ?? null,
      });
      return run;
    });
    registerActivityNotifier({
      id: 'test-push',
      channel: 'push',
      notify(event) { delivered.push(event); },
    });
  });

  afterAll(async () => {
    unregisterActivityNotifier('test-push');
    for (const node of agentizWorkflowNodes) nodeRegistry.unregister(node.type);
    await sequelize.close();
  });

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    launches.length = 0;
    delivered.length = 0;
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
    workflowEngineHolder().attach(engine);
    useWorkflowEvents({ emitter });

    projectId = (await AgentProject.create({ name: 'P', slug: 'p', ownerId: 7 } as any)).id;
    devSpecId = (await PipelineSpec.create({ projectId, name: 'dev', isActive: true, isDefault: true, spec: DEV_SPEC } as any)).id;
    qaSpecId = (await PipelineSpec.create({ projectId, name: 'qa', isActive: true, isDefault: false, spec: QA_SPEC } as any)).id;
    await AgentWorkflowSpec.create({
      name: 'Фича до релиза', active: true, version: 1, projectId,
      spec: referenceFlow(devSpecId, qaSpecId),
    } as any);
    await engine.rebindTriggers();
  });

  afterEach(async () => {
    forgetWorkflowEvents();
    workflowEngineHolder().detach();
    await engine.stop();
  });

  /** Finish the pipeline run the flow is parked on, the way a worker's result would. */
  async function finishLatestRun(patch: Record<string, unknown>): Promise<void> {
    const run = await AgentRun.findByPk(launches[launches.length - 1].runId);
    await run!.update({ status: 'succeeded', finishedAt: new Date(), ...patch });
    await settled();
  }

  /** The report every real run leaves in the thread — the classic way to feed a trigger itself. */
  async function reportRunToThread(runId: string, taskId: string): Promise<void> {
    await AgentTaskComment.create({
      taskId, authorKind: 'agent', authorName: `run ${runId.slice(0, 8)}`, authorId: null,
      runId, body: 'Запуск завершён.', externalId: null, externalUrl: null,
      meta: { kind: 'run.finished', runId },
    } as any);
    await settled();
  }

  async function newFeatureTask(): Promise<AgentTask> {
    const task = await AgentTask.create({
      projectId, externalId: 'local:1', title: 'Кнопка выхода', tags: ['фича'], status: 'new', priority: 'normal',
    } as any);
    await settled();
    return task;
  }

  it('граф с двумя входами и двумя сходящимися ветками проходит валидацию', () => {
    const spec = { id: 's', ...referenceFlow('dev', 'qa') };
    expect(validateWorkflowSpec(spec as any, nodeRegistry)).toEqual([]);
  });

  it('«не ок» от тестировщика возвращает задачу разработчику и сам начинает новый круг', async () => {
    const task = await newFeatureTask();

    // Круг 1: разработчик.
    expect(launches).toHaveLength(1);
    expect(launches[0].specId).toBe(devSpecId);
    expect((await AgentTask.findByPk(task.id))!.workflowStatus).toBe('В разработке');

    await finishLatestRun({ resultSummary: 'ветка feature/logout' });

    // Круг 1: тестировщик — своя спека, не та, что зарезолвилась бы по тегам.
    expect(launches).toHaveLength(2);
    expect(launches[1].specId).toBe(qaSpecId);
    expect((await AgentTask.findByPk(task.id))!.workflowStatus).toBe('На проверке');

    await finishLatestRun({ verdict: 'fail', verdictReason: 'на /logout 500' });

    // Замечания легли в тред — и этим подняли второй вход: круг 2 начался сам.
    const remark = await AgentTaskComment.findOne({ where: { taskId: task.id, authorKind: 'agent' } });
    expect(remark!.body).toContain('на /logout 500');
    expect(remark!.runId).toBeNull();

    expect(launches).toHaveLength(3);
    expect(launches[2].specId).toBe(devSpecId);
    // …и замечание доехало до агента как *текущее задание*, а не как одна из строк треда.
    expect(launches[2].triggerCommentId).toBe(remark!.id);

    // Два запуска флоу, оба привязаны к задаче — это и есть счётчик кругов.
    expect(await AgentWorkflowRun.count({ where: { taskId: task.id } })).toBe(2);
  });

  it('«ок» от тестировщика доводит работу до человека и будит именно его', async () => {
    const task = await newFeatureTask();
    await finishLatestRun({ resultSummary: 'сделано' });
    await finishLatestRun({ verdict: 'pass', verdictReason: null });

    expect((await AgentTask.findByPk(task.id))!.workflowStatus).toBe('Ждём человека');

    const approval = await AgentApprovalRequest.findOne({ where: { taskId: task.id } });
    expect(approval!.status).toBe('pending');
    expect(approval!.title).toContain(task.id);
    expect(approval!.message).toContain('pass');
    expect(approval!.assigneeToken).toBe('agentiz-approval-decide');

    // Флоу стоит и ждёт — durable, в базе, а не в памяти процесса.
    const parked = (await runStore.listActive()).at(0)!;
    expect(parked.status).toBe('waiting_external');
    expect(parked.externalRef).toBe(`approval:${approval!.id}`);

    // И человек об этом узнал. Это дальний конец цепочки ActivityService → activityNotifiers,
    // то есть ровно то, что получил бы телефон.
    const asked = delivered.filter((event) => event.activity.type === 'approval.requested');
    expect(asked).toHaveLength(1);
    expect(asked[0].delivery.push).toBe('on');
    // Владелец проекта — всегда среди адресатов, независимо от ролевых групп.
    expect(asked[0].context.recipientIds).toContain(7);
    expect((asked[0].activity.data as any).approvalId).toBe(approval!.id);
  });

  it('человек отклоняет с текстом — задача уходит на доработку и круг повторяется', async () => {
    const task = await newFeatureTask();
    await finishLatestRun({ resultSummary: 'сделано' });
    await finishLatestRun({ verdict: 'pass' });
    const approval = await AgentApprovalRequest.findOne({ where: { taskId: task.id } });

    // Отказ без причины не принимается: этот текст получает агент как следующее задание.
    await expect(ApprovalService.decide({ approvalId: approval!.id, actor: 7, decision: 'rejected', comment: '  ' }))
      .rejects.toThrow(/Причина отказа обязательна/);

    await ApprovalService.decide({
      approvalId: approval!.id, actor: 7, decision: 'rejected', comment: 'кнопка не там',
    });
    await settled();

    expect((await AgentApprovalRequest.findByPk(approval!.id))!.status).toBe('rejected');
    const remark = await AgentTaskComment.findOne({ where: { taskId: task.id, authorKind: 'agent' } });
    expect(remark!.body).toContain('кнопка не там');

    // Круг 2 стартовал сам, снова с разработчика.
    expect(launches).toHaveLength(3);
    expect(launches[2].specId).toBe(devSpecId);
    expect(launches[2].triggerCommentId).toBe(remark!.id);
  });

  it('человек принимает — задача помечена принятой, флоу закончилось, заявок не осталось', async () => {
    const task = await newFeatureTask();
    await finishLatestRun({ resultSummary: 'сделано' });
    await finishLatestRun({ verdict: 'pass' });
    const approval = await AgentApprovalRequest.findOne({ where: { taskId: task.id } });

    await ApprovalService.decide({ approvalId: approval!.id, actor: 7, decision: 'approved' });
    await settled();

    expect((await AgentTask.findByPk(task.id))!.workflowStatus).toBe('Принято');
    // Задача отпущена: ею больше никто не управляет.
    expect((await AgentTask.findByPk(task.id))!.currentWorkflowRunId).toBeNull();
    expect(launches).toHaveLength(2);
    const flowRun = (await AgentWorkflowRun.findAll()).at(0)!;
    expect(flowRun.status).toBe('succeeded');
    expect(flowRun.taskId).toBe(task.id);
    expect(await AgentApprovalRequest.count({ where: { status: 'pending' } })).toBe(0);

    // И решение тоже стало событием — «принято» видно в ленте, а не только в таблице.
    expect(delivered.some((event) => event.activity.type === 'approval.decided')).toBe(true);
  });

  it('второе решение по той же заявке отвергается, а не переигрывает граф', async () => {
    const task = await newFeatureTask();
    await finishLatestRun({ resultSummary: 'сделано' });
    await finishLatestRun({ verdict: 'pass' });
    const approval = await AgentApprovalRequest.findOne({ where: { taskId: task.id } });

    await ApprovalService.decide({ approvalId: approval!.id, actor: 7, decision: 'approved' });
    await settled();
    await expect(ApprovalService.decide({ approvalId: approval!.id, actor: 7, decision: 'rejected', comment: 'передумал' }))
      .rejects.toMatchObject({ status: 409 });
  });

  describe('предохранители: почему это не крутится вечно', () => {
    it('отчёт запуска в треде не поднимает вход — иначе каждый запуск перезапускал бы флоу', async () => {
      const task = await newFeatureTask();
      const runId = launches[0].runId;
      await finishLatestRun({ resultSummary: 'сделано' });
      await finishLatestRun({ verdict: 'pass' });
      const before = launches.length;

      await reportRunToThread(runId, task.id);

      expect(launches).toHaveLength(before);
    });

    it('служебная пометка статуса в треде тоже не поднимает вход', async () => {
      const task = await newFeatureTask();
      const before = launches.length;

      await AgentTaskComment.create({
        taskId: task.id, authorKind: 'system', authorName: 'workflow', authorId: null, runId: null,
        body: 'Ждём человека', externalId: null, externalUrl: null,
        meta: { kind: 'workflow.status', silent: true },
      } as any);
      await settled();

      expect(launches).toHaveLength(before);
    });

    it('пока флоу ведёт задачу, комментарии человека не плодят вторых запусков', async () => {
      const task = await newFeatureTask();
      const before = launches.length;
      expect((await AgentTask.findByPk(task.id))!.currentWorkflowRunId).not.toBeNull();

      for (const body of ['ещё мысль', 'и вот это', 'и ещё']) {
        await AgentTaskComment.create({
          taskId: task.id, authorKind: 'human', authorName: 'Пётр', authorId: 7, runId: null,
          body, externalId: null, externalUrl: null, meta: null,
        } as any);
      }
      await settled();

      expect(launches).toHaveLength(before);
    });

    it('на исчерпании кругов флоу останавливается и говорит об этом в карточке задачи', async () => {
      const task = await newFeatureTask();
      // Три круга «разработчик → тестировщик сказал fail» — четвёртый не должен начаться.
      for (let round = 0; round < 3; round += 1) {
        await finishLatestRun({ resultSummary: 'сделано' });
        await finishLatestRun({ verdict: 'fail', verdictReason: `круг ${round + 1}` });
      }

      expect(await AgentWorkflowRun.count({ where: { taskId: task.id } })).toBe(3);
      // 3 круга × 2 пайплайна; четвёртого круга нет.
      expect(launches).toHaveLength(6);
      expect((await AgentTask.findByPk(task.id))!.workflowStatus).toContain('Круги доработки исчерпаны');
    });

    it('отменённое флоу закрывает свою заявку, а не оставляет её висеть у человека', async () => {
      const task = await newFeatureTask();
      await finishLatestRun({ resultSummary: 'сделано' });
      await finishLatestRun({ verdict: 'pass' });
      const approval = await AgentApprovalRequest.findOne({ where: { taskId: task.id } });
      const flowRun = (await AgentWorkflowRun.findOne({ where: { status: 'waiting_external' } }))!;

      await engine.cancel(flowRun.id);
      await settled();

      expect((await AgentApprovalRequest.findByPk(approval!.id))!.status).toBe('cancelled');
      expect((await AgentTask.findByPk(task.id))!.currentWorkflowRunId).toBeNull();
    });

    it('пока флоу ведёт задачу, spec.triggers.humanComment не запускает второй пайплайн', async () => {
      const task = await newFeatureTask();
      await PipelineSpec.update(
        { spec: { ...DEV_SPEC, triggers: { humanComment: true } } as any },
        { where: { id: devSpecId } },
      );

      const comment = await AgentTaskComment.create({
        taskId: task.id, authorKind: 'human', authorName: 'Пётр', authorId: 7, runId: null,
        body: 'подскажу', externalId: null, externalUrl: null, meta: null,
      } as any);

      expect(await AgentPipelineService.runForHumanComment(task.id, comment.id)).toBeNull();
    });
  });

  describe('старые графы работают ровно как раньше', () => {
    /**
     * The rule from AGENTS.md, applied to a workflow spec instead of a pipeline one: a graph saved
     * before these fields existed has to come out the other end identical — same resolution, same
     * defaults, same number of runs. "It doesn't error" is not that proof, so this walks a
     * legacy-shaped spec (the fields **absent**, not merely false) through a real run.
     */
    const legacyFlow = {
      nodes: [
        // No authorKind, no maxRounds, no skipIfFlowActive, no specId: exactly what a spec written
        // before this feature contains.
        { id: 'arrived', type: 'agentiz.task.trigger', config: { event: 'agentiz.task.created' } },
        { id: 'pipe', type: 'agentiz.pipeline', config: {} },
      ],
      edges: [{ from: 'arrived', to: 'pipe' }],
    };

    beforeEach(async () => {
      await AgentWorkflowSpec.update({ spec: legacyFlow }, { where: {} });
      await engine.rebindTriggers();
    });

    it('пайплайн без specId по-прежнему резолвится по тегам/дефолту', async () => {
      await newFeatureTask();
      expect(launches).toHaveLength(1);
      // The task's tags match nothing, so the project's default spec is used — the pre-existing
      // resolution, untouched by the new config.
      expect(launches[0].specId).toBe(devSpecId);
      expect(launches[0].triggerCommentId).toBeNull();
    });

    it('вход «задача создана» не наследует строгих умолчаний входа-комментария', async () => {
      const task = await newFeatureTask();
      expect(launches).toHaveLength(1);

      // A second task in the same project starts a second flow: `skipIfFlowActive` defaults to off
      // for this event, exactly as before the flag existed.
      await AgentTask.create({
        projectId, externalId: 'local:2', title: 'Ещё одна', status: 'new', priority: 'normal',
      } as any);
      await settled();
      expect(launches).toHaveLength(2);

      // And no round limit: three more tasks, three more runs.
      for (const index of [3, 4, 5]) {
        await AgentTask.create({
          projectId, externalId: `local:${index}`, title: `Задача ${index}`, status: 'new', priority: 'normal',
        } as any);
      }
      await settled();
      expect(launches).toHaveLength(5);
      expect(task.workflowStatus ?? null).toBeNull();
    });

    it('комментарий не поднимает старый граф вовсе — события он не слушает', async () => {
      const task = await newFeatureTask();
      const before = launches.length;

      await AgentTaskComment.create({
        taskId: task.id, authorKind: 'human', authorName: 'Пётр', authorId: 7, runId: null,
        body: 'что-нибудь', externalId: null, externalUrl: null, meta: null,
      } as any);
      await settled();

      expect(launches).toHaveLength(before);
    });
  });
});
