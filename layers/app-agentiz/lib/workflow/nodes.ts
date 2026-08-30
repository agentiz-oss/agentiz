import type {
  ExternalRef,
  NodeContext,
  NodeResult,
  NodeTypeDefinition,
  TriggerBindingContext,
  WorkflowMsg,
} from '@nodeknit/app-workflow';
import { AgentTask } from '../../models/AgentTask';
import { AgentPipelineService } from '../../services/AgentPipelineService';
import type { AgentRunTrigger, AgentTaskStatus } from '../../types/agentiz';
import {
  AGENTIZ_TASK_CREATED,
  AGENTIZ_TASK_UPDATED,
  type AgentizTaskEventPayload,
} from './events';
import { pipelineRunRef } from './engineBridge';
import { pipelineDocs, taskMatchDocs, taskRunDocs, taskTriggerDocs } from './nodeDocs';

/**
 * The node types app-agentiz contributes to the workflow palette — the smallest set that
 * expresses "задача пришла → стоит ли её запускать → запустить пайплайн".
 *
 * They are domain nodes on purpose. The engine's own generic set (`trigger.event`, `switch`,
 * `template`, …) is not written yet, and the two generic ones this flow would need cannot express
 * it anyway: `switch` compares literals, while the question here is substring-or-tag over a task.
 * When the generic set lands, these stay — a node that knows what a task is reads better in the
 * canvas than three generic ones wired together.
 *
 * Everything is contributed as plain data through the `workflowNodes` collection, so app-agentiz
 * has no runtime dependency on `@nodeknit/app-workflow` (types only): with the engine disabled the
 * definitions are simply never read.
 */

/** `msg.payload` of every node here — the task, flat, as the trigger put it. */
type TaskPayload = AgentizTaskEventPayload & Record<string, unknown>;

function payloadOf(msg: WorkflowMsg): TaskPayload | null {
  const payload = msg?.payload as TaskPayload | undefined;
  return payload && typeof payload === 'object' && typeof payload.taskId === 'string' ? payload : null;
}

/**
 * A list field as the generated form can render it. The canvas drops the *whole* config to a JSON
 * textarea as soon as one property is an array (see PropertyEditor.schemaIsSimple), so the schema
 * says "string" and this accepts either — a person types `выполни, сделай`, an MCP agent may still
 * write an array.
 */
function stringList(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value.map((item) => String(item))
    : String(value ?? '').split(/[,\n]/);
  return items.map((item) => item.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// trigger: a task arrived
// ---------------------------------------------------------------------------

/**
 * Unsubscribe handles by `listenerKey` (`flow:<specId>:<nodeId>`, deterministic per the engine's
 * contract), so `bind` can drop a previous listener for the same key.
 *
 * That is not belt-and-braces: `WorkflowEngine` schedules a rebind when a spec provider is added
 * *and* `AppWorkflow.mount()` awaits one right after, so two rebinds interleave on startup and the
 * node is bound twice — which would run the flow twice for one task. Being idempotent here costs
 * one lookup and does not depend on the engine growing a lock.
 */
const boundTaskTriggers = new Map<string, () => void>();

export const taskEventTriggerNode: NodeTypeDefinition = {
  type: 'agentiz.task.trigger',
  name: 'Задача Agentiz',
  description: 'Срабатывает, когда в Agentiz появилась (или изменилась) задача',
  docs: taskTriggerDocs,
  category: 'Agentiz',
  kind: 'trigger',
  ports: { inputs: 0, outputs: ['out'] },
  configSchema: {
    type: 'object',
    properties: {
      event: {
        title: 'Событие',
        description: 'Какое событие задачи слушать',
        enum: [AGENTIZ_TASK_CREATED, AGENTIZ_TASK_UPDATED],
        default: AGENTIZ_TASK_CREATED,
      },
      projectId: {
        type: 'string',
        title: 'Проект (id)',
        description: 'Пусто = задачи всех проектов',
      },
    },
  },
  trigger: {
    bind(ctx: TriggerBindingContext): void {
      const eventKey = String(ctx.config.event ?? AGENTIZ_TASK_CREATED);
      const projectId = String(ctx.config.projectId ?? '').trim();
      boundTaskTriggers.get(ctx.listenerKey)?.();
      const off = ctx.eventBus.on(eventKey, (raw) => {
        const payload = raw as AgentizTaskEventPayload | undefined;
        if (!payload || typeof payload.taskId !== 'string') return;
        if (projectId && payload.projectId !== projectId) return;
        // The emit is synchronous inside whoever wrote the task: start the run and get out.
        void ctx.fire({ payload }).catch((error) => {
          console.error(`[AppAgentiz] workflow trigger ${ctx.listenerKey} failed to start:`, error);
        });
      });
      boundTaskTriggers.set(ctx.listenerKey, off);
    },
    unbind(ctx: TriggerBindingContext): void {
      boundTaskTriggers.get(ctx.listenerKey)?.();
      boundTaskTriggers.delete(ctx.listenerKey);
    },
  },
};

// ---------------------------------------------------------------------------
// server: does this task deserve a run?
// ---------------------------------------------------------------------------

export const taskMatchNode: NodeTypeDefinition = {
  type: 'agentiz.task.match',
  name: 'Проверка задачи',
  description: 'Ищет слова в названии/описании и теги задачи; два выхода — подходит и нет',
  docs: taskMatchDocs,
  category: 'Agentiz',
  kind: 'server',
  ports: { inputs: 1, outputs: ['match', 'no'] },
  configSchema: {
    type: 'object',
    properties: {
      keywords: {
        type: 'string',
        title: 'Слова',
        description: 'Через запятую. Ищутся как подстроки, регистр не важен. Например: выполни',
      },
      fields: {
        title: 'Где искать слова',
        enum: ['both', 'title', 'description'],
        default: 'both',
      },
      tags: {
        type: 'string',
        title: 'Теги',
        description: 'Через запятую. Например: todo',
      },
      require: {
        title: 'Условие',
        description: 'any — достаточно слова или тега; all — нужно и слово, и тег',
        enum: ['any', 'all'],
        default: 'any',
      },
    },
  },
  executor: {
    async execute(ctx: NodeContext): Promise<NodeResult> {
      const payload = payloadOf(ctx.msg);
      if (!payload) throw new Error('msg.payload не похож на задачу Agentiz (нет taskId)');

      const keywords = stringList(ctx.config.keywords).map((word) => word.toLowerCase());
      const tags = stringList(ctx.config.tags).map((tag) => tag.toLowerCase());
      const fields = String(ctx.config.fields ?? 'both');
      const requireAll = String(ctx.config.require ?? 'any') === 'all';

      const haystack = [
        fields === 'description' ? '' : payload.title ?? '',
        fields === 'title' ? '' : payload.description ?? '',
      ].join('\n').toLowerCase();
      const taskTags = new Set((payload.tags ?? []).map((tag) => String(tag).toLowerCase()));

      const matchedKeywords = keywords.filter((word) => haystack.includes(word));
      const matchedTags = tags.filter((tag) => taskTags.has(tag));

      // A condition nobody filled in matches nothing: an empty node quietly passing every task
      // into a pipeline is the one failure mode worth being blunt about.
      const keywordHit = keywords.length > 0 && matchedKeywords.length > 0;
      const tagHit = tags.length > 0 && matchedTags.length > 0;
      const matched = requireAll
        ? keywords.length > 0 && tags.length > 0 && keywordHit && tagHit
        : keywordHit || tagHit;

      ctx.logger.info(
        `[agentiz.task.match] "${payload.title}" → ${matched ? 'подходит' : 'мимо'}`,
        { keywords: matchedKeywords, tags: matchedTags },
      );

      return {
        output: matched ? 'match' : 'no',
        msg: { ...ctx.msg, payload: { ...payload, match: { matched, keywords: matchedKeywords, tags: matchedTags } } },
      };
    },
  },
};

// ---------------------------------------------------------------------------
// server: start the pipeline
// ---------------------------------------------------------------------------

/** Statuses in which a run already owns the task — starting a second one would fight it. */
const RUN_OWNED: AgentTaskStatus[] = ['queued', 'running', 'waiting_input'];

/**
 * Fire-and-forget: it queues the pipeline and the flow walks on. `agentiz.pipeline` below is the
 * same launch with a wait — two node types rather than a flag, because a node's kind (`server` vs
 * `external`) is what the engine dispatches on and cannot depend on its config.
 */
export const taskRunNode: NodeTypeDefinition = {
  type: 'agentiz.task.run',
  name: 'Запустить пайплайн (без ожидания)',
  description: 'Ставит задачу в пайплайн и идёт дальше, не дожидаясь результата',
  docs: taskRunDocs,
  category: 'Agentiz',
  kind: 'server',
  ports: { inputs: 1, outputs: ['out'] },
  configSchema: {
    type: 'object',
    properties: {
      trigger: {
        title: 'Чем помечать запуск',
        description: 'Значение AgentRun.trigger — своего значения "workflow" в ENUM пока нет',
        enum: ['sync', 'manual', 'webhook', 'schedule'],
        default: 'sync',
      },
      skipIfActive: {
        type: 'boolean',
        title: 'Не запускать, если задача уже в работе',
        default: true,
      },
    },
  },
  executor: {
    async execute(ctx: NodeContext): Promise<NodeResult> {
      const payload = payloadOf(ctx.msg);
      if (!payload) throw new Error('msg.payload не похож на задачу Agentiz (нет taskId)');

      const skipIfActive = ctx.config.skipIfActive !== false;
      if (skipIfActive) {
        // Re-read instead of trusting the payload: the event was frozen when the task was written,
        // and a run may have started between then and this node.
        const task = await AgentTask.findByPk(payload.taskId);
        if (!task) throw new Error(`Задача ${payload.taskId} не найдена`);
        if (RUN_OWNED.includes(task.status)) {
          ctx.logger.info(`[agentiz.task.run] задача ${task.id} уже в статусе "${task.status}", запуск пропущен`);
          return { msg: { ...ctx.msg, payload: { ...payload, runId: null, skipped: `task_${task.status}` } } };
        }
      }

      const trigger = String(ctx.config.trigger ?? 'sync') as AgentRunTrigger;
      // runTask, not createRun: it also queues the worker job and reports a misconfiguration as a
      // failed run instead of leaving the task queued forever.
      const run = await AgentPipelineService.runTask(payload.taskId, trigger);
      ctx.logger.info(`[agentiz.task.run] задача ${payload.taskId} → запуск ${run.id}`);
      return { msg: { ...ctx.msg, payload: { ...payload, runId: run.id, skipped: null } } };
    },
  },
};

// ---------------------------------------------------------------------------
// external: start the pipeline and wait for it
// ---------------------------------------------------------------------------

export const pipelineNode: NodeTypeDefinition = {
  type: 'agentiz.pipeline',
  name: 'Пайплайн (с ожиданием)',
  description: 'Запускает пайплайн и продолжает флоу, когда запуск завершился: выходы «успех», «ошибка», «pass», «fail»',
  docs: pipelineDocs,
  category: 'Agentiz',
  kind: 'external',
  // `pass`/`fail` fire only for a pipeline whose last stage has `verdict: true`; `succeeded` never
  // fires for one — see completePipelineWait (engineBridge.ts) and pipelineDocs below.
  ports: { inputs: 1, outputs: ['succeeded', 'failed', 'pass', 'fail'] },
  configSchema: {
    type: 'object',
    properties: {
      trigger: {
        title: 'Чем помечать запуск',
        enum: ['sync', 'manual', 'webhook', 'schedule'],
        default: 'sync',
      },
    },
  },
  /**
   * `external`, not a server node that polls: a pipeline takes minutes to hours, and the engine's
   * in-process timeout is measured in seconds. The run parks in `waiting_external` keyed by
   * `run:<id>`, and the `AgentRun` terminal hook hands the outcome back through
   * `completePipelineWait` — which is also why this only continues across a restart when the
   * durable run store is installed (lib/workflow/runStore.ts).
   *
   * The gap worth knowing: the engine writes `waiting_external` *after* `dispatch` returns, so a
   * pipeline that terminalized inside `runTask` itself would report before there is anything to
   * report to. In practice the only such path throws instead (a run that cannot be queued), which
   * fails this node — a visible failure, not a stuck flow.
   */
  external: {
    async dispatch(ctx: NodeContext): Promise<ExternalRef> {
      const payload = payloadOf(ctx.msg);
      if (!payload) throw new Error('msg.payload не похож на задачу Agentiz (нет taskId)');
      const trigger = String(ctx.config.trigger ?? 'sync') as AgentRunTrigger;
      const run = await AgentPipelineService.runTask(payload.taskId, trigger);
      ctx.logger.info(`[agentiz.pipeline] задача ${payload.taskId} → запуск ${run.id}, ждём результата`);
      return pipelineRunRef(run.id);
    },
  },
};

export const agentizWorkflowNodes: NodeTypeDefinition[] = [
  taskEventTriggerNode,
  taskMatchNode,
  taskRunNode,
  pipelineNode,
];
