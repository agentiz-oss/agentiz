import type {
  ExternalRef,
  NodeContext,
  NodeResult,
  NodeTypeDefinition,
  TriggerBindingContext,
  WorkflowMsg,
} from '@nodeknit/app-workflow';
import { AgentTask } from '../../models/AgentTask';
import { AgentWorkspaceProposal } from '../../models/AgentWorkspaceProposal';
import { AgentTaskComment } from '../../models/AgentTaskComment';
import { AgentWorkflowRun } from '../../models/AgentWorkflowRun';
import { AgentPipelineService } from '../../services/AgentPipelineService';
import { AgentTaskService } from '../../services/AgentTaskService';
import { ApprovalService } from '../../services/ApprovalService';
import { PROJECT_TOKENS } from '../access/tokens';
import type { AgentRunTrigger, AgentTaskStatus } from '../../types/agentiz';
import {
  AGENTIZ_TASK_COMMENTED,
  AGENTIZ_TASK_CREATED,
  AGENTIZ_TASK_UPDATED,
  type AgentizTaskCommentedPayload,
  type AgentizTaskEventPayload,
} from './events';
import { approvalRef, pipelineRunRef } from './engineBridge';
import {
  approvalDocs,
  pipelineDocs,
  taskCommentDocs,
  taskCreateDocs,
  taskMatchDocs,
  taskRunDocs,
  taskStatusDocs,
  tasksQueryDocs,
  taskTriggerDocs,
} from './nodeDocs';

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

/**
 * `{{payload.title}}` — the only templating these nodes do, and deliberately the whole of it.
 *
 * Values are looked up by dotted path in `msg` and substituted as text; an unknown path becomes an
 * empty string rather than the literal `{{…}}`, because half-rendered text in a task card reads as
 * a bug in Agentiz rather than as a typo in a node. Nothing here evaluates anything: the strings
 * involved (a task title, an agent's summary, a person's rejection text) come from outside, and
 * anything that could execute them would be a command injection with extra steps — the same rule
 * `lib/hookEnv.ts` follows for hook scripts.
 */
function renderTemplate(template: unknown, msg: WorkflowMsg): string {
  return String(template ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    let current: unknown = msg;
    for (const key of path.split('.')) {
      if (current === null || current === undefined || typeof current !== 'object') return '';
      current = (current as Record<string, unknown>)[key];
    }
    if (current === null || current === undefined) return '';
    return typeof current === 'object' ? JSON.stringify(current) : String(current);
  });
}

/**
 * `Название|https://…` per line — the array-free shape the generated form can still render.
 *
 * Takes the text **after** substitution, not the raw config: a link is the one field of an approval
 * whose whole purpose is to point at what this particular run produced, so a literal
 * `{{payload.branch}}` in it is the only outcome that is certainly wrong. It went unsubstituted from
 * the day the node shipped — the title and the message were rendered and this was not — and the
 * symptom was a person tapping a link to `…?taskId={{payload.taskId}}`.
 *
 * A substituted value is a single line by construction here: anything containing a newline would
 * otherwise turn one link into two, so line breaks inside a value are folded to spaces before the
 * text is split.
 */
function parseLinks(value: unknown): Array<{ label: string; url: string }> {
  return String(value ?? '')
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf('|');
      if (separator < 0) return { label: line, url: line };
      return { label: line.slice(0, separator).trim(), url: line.slice(separator + 1).trim() };
    })
    .filter((link) => link.url.length > 0);
}

/**
 * `renderTemplate` for the links field: same substitution, with every value folded onto one line.
 *
 * The folding is what makes it safe to substitute into a list whose separator is the newline. It is
 * not a security boundary — nothing here is executed, and the URL is stored and shown, never run —
 * but a value with a line break in it (an agent's summary, a rejection text) would silently produce
 * a second, malformed link, and a malformed link in a decision is worse than no link.
 */
function renderLinkTemplate(template: unknown, msg: WorkflowMsg): string {
  return String(template ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, path: string) => {
    const value = renderTemplate(`{{${path}}}`, msg);
    return value.replace(/[\r\n]+/g, ' ').trim();
  });
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

/**
 * How many rounds of rework the comment input allows before it stops raising the flow.
 *
 * Applied **only** to `agentiz.task.commented`, and that asymmetry is the whole point: the comment
 * input is the one that a flow can raise by its own last node (the graph ends with a remark in the
 * thread — see plan §9), so without a ceiling "агент не понял замечание" is an infinite loop that
 * spends real money. The other two events are raised by a person or by a tracker sync and have no
 * such property, so a limit there would only be a new way to silently not run.
 *
 * `0` means unlimited and is what every event other than the comment one defaults to, which is
 * also exactly the behaviour of every graph written before this config existed.
 */
const DEFAULT_COMMENT_MAX_ROUNDS = 3;

/**
 * Config the comment input needs and the other two inputs must not have defaults changed by.
 *
 * A graph saved before this field existed has no `authorKind`, no `maxRounds` and no
 * `skipIfFlowActive` — and `agentiz.task.commented` did not exist either, so a per-event default
 * can be strict without touching a single legacy spec. That is the trade taken here: strict where
 * nothing can already depend on it, byte-identical where something can.
 */
function triggerFilters(config: Record<string, unknown>, eventKey: string) {
  const isComment = eventKey === AGENTIZ_TASK_COMMENTED;
  const authorKinds = new Set(
    stringList(config.authorKind ?? (isComment ? 'human' : '')).map((kind) => kind.toLowerCase()),
  );
  const configuredRounds = Number(config.maxRounds ?? NaN);
  const maxRounds = Number.isFinite(configuredRounds)
    ? Math.max(0, Math.floor(configuredRounds))
    : (isComment ? DEFAULT_COMMENT_MAX_ROUNDS : 0);
  const skipIfFlowActive = config.skipIfFlowActive === undefined
    ? isComment
    : config.skipIfFlowActive !== false;
  return { isComment, authorKinds, maxRounds, skipIfFlowActive };
}

export const taskEventTriggerNode: NodeTypeDefinition = {
  type: 'agentiz.task.trigger',
  name: 'Задача Agentiz',
  description: 'Срабатывает, когда в Agentiz появилась, изменилась или прокомментирована задача',
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
        enum: [AGENTIZ_TASK_CREATED, AGENTIZ_TASK_UPDATED, AGENTIZ_TASK_COMMENTED],
        default: AGENTIZ_TASK_CREATED,
      },
      projectId: {
        type: 'string',
        title: 'Проект (id)',
        description: 'Пусто = задачи всех проектов',
      },
      authorKind: {
        type: 'string',
        title: 'Кто написал комментарий',
        description:
          'Только для события «прокомментирована». Через запятую: human, agent, system.'
          + ' Пусто = любой. По умолчанию human — чтобы круг замыкался сам, впишите human, agent',
      },
      maxRounds: {
        type: 'number',
        title: 'Сколько кругов допускать',
        description:
          'Сколько запусков этого флоу по одной задаче разрешено. 0 = без ограничения.'
          + ' Для события «прокомментирована» по умолчанию 3',
      },
      skipIfFlowActive: {
        type: 'boolean',
        title: 'Не стартовать поверх живого флоу',
        description:
          'Не начинать новый запуск, пока задачей управляет другой.'
          + ' Для события «прокомментирована» по умолчанию включено',
      },
    },
  },
  trigger: {
    bind(ctx: TriggerBindingContext): void {
      const eventKey = String(ctx.config.event ?? AGENTIZ_TASK_CREATED);
      const projectId = String(ctx.config.projectId ?? '').trim();
      const { isComment, authorKinds, maxRounds, skipIfFlowActive } = triggerFilters(ctx.config, eventKey);
      boundTaskTriggers.get(ctx.listenerKey)?.();
      const off = ctx.eventBus.on(eventKey, (raw) => {
        const payload = raw as (AgentizTaskCommentedPayload & AgentizTaskEventPayload) | undefined;
        if (!payload || typeof payload.taskId !== 'string') return;
        if (projectId && payload.projectId !== projectId) return;

        if (isComment) {
          // Two hard rules, deliberately not settings. `reportToTaskThread` writes the outcome of
          // **every** run into the thread with `runId` filled, and a status node may leave a note
          // of its own: reacting to either is reacting to our own output, and one careless graph
          // would then run pipelines until somebody noticed the bill.
          if (payload.runId) return;
          if (payload.silent) return;
          if (authorKinds.size > 0 && !authorKinds.has(String(payload.authorKind ?? '').toLowerCase())) return;
        }

        // The emit is synchronous inside whoever wrote the task/comment: decide out of band and
        // return immediately, exactly as the single-filter version did.
        void (async () => {
          if (skipIfFlowActive || maxRounds > 0) {
            const task = await AgentTask.findByPk(payload.taskId);
            if (!task) return;
            if (skipIfFlowActive && task.currentWorkflowRunId) {
              console.info(
                `[AppAgentiz] trigger ${ctx.listenerKey}: task ${task.id} is already driven by`
                + ` workflow run ${task.currentWorkflowRunId}, not starting a second one`,
              );
              return;
            }
            if (maxRounds > 0) {
              // Counted in the database, not in engine state: every round is its own
              // `AgentWorkflowRun`, so this is also the number a person can see and argue with.
              const rounds = await AgentWorkflowRun.count({ where: { taskId: task.id, specId: ctx.specId } });
              if (rounds >= maxRounds) {
                const text = `Круги доработки исчерпаны (${rounds} из ${maxRounds}) — нужен человек`;
                console.warn(`[AppAgentiz] trigger ${ctx.listenerKey}: ${text} (task ${task.id})`);
                // Said out loud on the task rather than only in a log — and said as a *status*,
                // not as a comment, because a comment here is precisely what would raise this
                // trigger again. `workflowStatus` is not a watched field, so nothing wakes.
                if (task.workflowStatus !== text) {
                  await task.update({ workflowStatus: text, workflowStatusAt: new Date() });
                }
                return;
              }
            }
          }
          await ctx.fire({ payload });
        })().catch((error) => {
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
      specId: {
        type: 'string',
        title: 'Пайплайн (id спеки)',
        description:
          'Пусто = как раньше: спека подбирается по тегам задачи, иначе дефолтная.'
          + ' Граф «разработчик → тестировщик» называет две разные спеки, и по тегам их не различить',
      },
      useTriggerComment: {
        type: 'boolean',
        title: 'Передать комментарий как текущее задание',
        description:
          'Если флоу начался с комментария, отдать его агенту как задание, а не как фон треда.'
          + ' По умолчанию включено',
        default: true,
      },
      passPayload: {
        type: 'boolean',
        title: 'Передать данные флоу в хуки',
        description:
          'Отдать msg.payload запуску: хук-скрипт получит его как переменную AGENTIZ_WORKFLOW_INPUT'
          + ' (json). Нужно релизному пайплайну, чтобы узнать список веток. По умолчанию выключено',
        default: false,
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
      const specId = String(ctx.config.specId ?? '').trim() || null;
      // The remark the round started from, handed to the agent as its **current instruction**.
      // Without it `conversationForRun` leaves the comment as one more line of the thread, and the
      // agent reads the run as "сделай задачу заново" rather than "поправь вот это" — the круг then
      // works formally and not at all in substance (plan §9.4).
      const triggerCommentId = ctx.config.useTriggerComment === false
        ? null
        : (typeof payload.commentId === 'string' ? payload.commentId : null);
      // Off unless asked for: a pipeline written before workflows could pass anything must get the
      // environment it always got, and `payload` carries whatever every upstream node put there.
      const input = ctx.config.passPayload === true ? { ...payload } : null;
      const run = await AgentPipelineService.runTask(payload.taskId, trigger, {
        ...(specId ? { pipelineSpecId: specId } : {}),
        ...(triggerCommentId ? { triggerCommentId } : {}),
        ...(input ? { input } : {}),
      });
      ctx.logger.info(`[agentiz.pipeline] задача ${payload.taskId} → запуск ${run.id}, ждём результата`);
      return pipelineRunRef(run.id);
    },
  },
};

// ---------------------------------------------------------------------------
// server: say where the task stands, in the customer's words
// ---------------------------------------------------------------------------

export const taskStatusNode: NodeTypeDefinition = {
  type: 'agentiz.task.status',
  name: 'Статус задачи (текст)',
  description: 'Пишет в карточку задачи текстовый статус воркфлоу — «ждём человека», «на доработке»',
  docs: taskStatusDocs,
  category: 'Agentiz',
  kind: 'server',
  ports: { inputs: 1, outputs: ['out'] },
  configSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        title: 'Текст статуса',
        description: 'Можно подставлять значения: {{payload.title}}, {{payload.verdict}}, {{payload.summary}}',
      },
      alsoComment: {
        type: 'boolean',
        title: 'Продублировать в тред задачи',
        description: 'Пометка в треде — она никогда не поднимает триггер «прокомментирована»',
        default: false,
      },
    },
  },
  executor: {
    async execute(ctx: NodeContext): Promise<NodeResult> {
      const payload = payloadOf(ctx.msg);
      if (!payload) throw new Error('msg.payload не похож на задачу Agentiz (нет taskId)');
      const text = renderTemplate(ctx.config.text, ctx.msg).trim();
      if (!text) throw new Error('agentiz.task.status: текст статуса пуст');

      const task = await AgentTask.findByPk(payload.taskId);
      if (!task) throw new Error(`Задача ${payload.taskId} не найдена`);
      // Never `status` — that ENUM belongs to the pipeline. This column is free text and is
      // deliberately outside WORKFLOW_WATCHED_FIELDS, so writing it wakes nothing.
      await task.update({ workflowStatus: text.slice(0, 250), workflowStatusAt: new Date() });

      if (ctx.config.alsoComment === true) {
        await AgentTaskComment.create({
          taskId: task.id,
          authorKind: 'system',
          authorName: 'workflow',
          authorId: null,
          runId: null,
          body: text,
          externalId: null,
          externalUrl: null,
          // `silent` is a hard rule on the comment trigger: a flow narrating its own progress must
          // not be mistaken for a remark somebody has to react to.
          meta: { kind: 'workflow.status', silent: true, workflowRunId: ctx.runId, nodeId: ctx.nodeId },
        });
      }

      ctx.logger.info(`[agentiz.task.status] задача ${task.id}: "${text}"`);
      return { msg: { ...ctx.msg, payload: { ...payload, workflowStatus: text } } };
    },
  },
};

// ---------------------------------------------------------------------------
// server: the remark that ends a round
// ---------------------------------------------------------------------------

export const taskCommentNode: NodeTypeDefinition = {
  type: 'agentiz.task.comment',
  name: 'Комментарий в задачу',
  description: 'Пишет замечания в тред задачи — этим и замыкается круг доработки',
  docs: taskCommentDocs,
  category: 'Agentiz',
  kind: 'server',
  ports: { inputs: 1, outputs: ['out'] },
  configSchema: {
    type: 'object',
    properties: {
      body: {
        type: 'string',
        title: 'Текст',
        description: 'Подстановки: {{payload.summary}}, {{payload.comment}}, {{payload.verdict}}, {{payload.error}}',
      },
      authorKind: {
        title: 'От чьего имени',
        enum: ['agent', 'human', 'system'],
        default: 'agent',
      },
      releasesTask: {
        type: 'boolean',
        title: 'Отпустить задачу (конец круга)',
        description:
          'Снимает с задачи признак «ей управляет этот флоу» до записи комментария,'
          + ' чтобы следующий круг мог стартовать. По умолчанию включено',
        default: true,
      },
    },
  },
  executor: {
    async execute(ctx: NodeContext): Promise<NodeResult> {
      const payload = payloadOf(ctx.msg);
      if (!payload) throw new Error('msg.payload не похож на задачу Agentiz (нет taskId)');
      const body = renderTemplate(ctx.config.body, ctx.msg).trim();
      if (!body) throw new Error('agentiz.task.comment: текст комментария пуст');

      const task = await AgentTask.findByPk(payload.taskId);
      if (!task) throw new Error(`Задача ${payload.taskId} не найдена`);

      // Order matters, and this is the whole reason the flag exists. The comment is what raises
      // the "прокомментирована" input; if the task were still marked as owned by *this* flow at
      // that moment, `skipIfFlowActive` would swallow the next round and the loop would end here
      // instead of going back to the developer.
      if (ctx.config.releasesTask !== false && task.currentWorkflowRunId === ctx.runId) {
        await task.update({ currentWorkflowRunId: null });
      }

      const authorKind = String(ctx.config.authorKind ?? 'agent');
      const comment = await AgentTaskComment.create({
        taskId: task.id,
        authorKind: authorKind as never,
        authorName: 'workflow',
        authorId: null,
        // Deliberately null: a comment carrying a runId is a *run's report* and never wakes the
        // comment trigger. This one is the point of the round and must.
        runId: null,
        body,
        externalId: null,
        externalUrl: null,
        meta: { kind: 'workflow.comment', workflowRunId: ctx.runId, nodeId: ctx.nodeId },
      });

      ctx.logger.info(`[agentiz.task.comment] задача ${task.id} ← комментарий ${comment.id}`);
      return { msg: { ...ctx.msg, payload: { ...payload, commentId: comment.id } } };
    },
  },
};

// ---------------------------------------------------------------------------
// external: a person decides
// ---------------------------------------------------------------------------

export const approvalNode: NodeTypeDefinition = {
  type: 'agentiz.approval',
  name: 'Решение человека',
  description: 'Паркует флоу, пока человек не примет или не отклонит работу; выходы «принято» и «отклонено»',
  docs: approvalDocs,
  category: 'Agentiz',
  kind: 'external',
  ports: { inputs: 1, outputs: ['approved', 'rejected'] },
  configSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        title: 'Заголовок',
        description: 'Одна строка, которую человек увидит в списке. Подстановки как везде: {{payload.title}}',
      },
      message: {
        type: 'string',
        title: 'Текст',
        description: 'Что проверить и на что смотреть. {{payload.verdict}}, {{payload.verdictReason}},'
          + ' {{payload.branch}}, {{payload.filesChanged}}. Не {{payload.summary}} — это экраны прозы',
      },
      assigneeToken: {
        type: 'string',
        title: 'Кому адресовать (проектный токен)',
        description: `Пусто = ${PROJECT_TOKENS.approvalDecide} (роль «Тестировщики» и все ступени выше)`,
      },
      assigneeUserId: {
        type: 'number',
        title: 'Конкретный человек (id)',
        description: 'Пусто = любой, кто вправе. Право всё равно проверяется по токену',
      },
      links: {
        type: 'string',
        title: 'Ссылки',
        description: 'По одной в строке, в виде «Название|https://…». Диф и так открывается кнопкой;'
          + ' сюда — превью и внешнее. Подстановки: {{payload.branchSlug}}, {{payload.commitUrl}}',
      },
    },
  },
  /**
   * `external` for the same reason `agentiz.pipeline` is: a person thinks for hours and a server
   * node's timeout is 30 seconds. Unlike a pipeline, though, nothing here holds a worker or a
   * directory — the flow simply waits, and the row (`AgentApprovalRequest`) outlives the run, the
   * restart and the deploy. The continuation comes from `ApprovalService.decide`, which decides
   * the row first and only then hands the outcome back (`completeApprovalWait`).
   */
  external: {
    async dispatch(ctx: NodeContext): Promise<ExternalRef> {
      const payload = payloadOf(ctx.msg);
      if (!payload) throw new Error('msg.payload не похож на задачу Agentiz (нет taskId)');
      const task = await AgentTask.findByPk(payload.taskId);
      if (!task) throw new Error(`Задача ${payload.taskId} не найдена`);

      const assigneeUserId = Number(ctx.config.assigneeUserId ?? NaN);
      const { approval, created } = await ApprovalService.request({
        projectId: task.projectId,
        taskId: task.id,
        workflowRunId: ctx.runId,
        nodeId: ctx.nodeId,
        runId: typeof payload.runId === 'string' ? payload.runId : null,
        assigneeUserId: Number.isFinite(assigneeUserId) ? assigneeUserId : null,
        assigneeToken: String(ctx.config.assigneeToken ?? '').trim() || null,
        title: renderTemplate(ctx.config.title, ctx.msg).trim() || `Примите работу: ${task.title}`,
        message: renderTemplate(ctx.config.message, ctx.msg).trim() || null,
        links: parseLinks(renderLinkTemplate(ctx.config.links, ctx.msg)),
      });

      ctx.logger.info(
        `[agentiz.approval] задача ${task.id} → заявка ${approval.id}${created ? '' : ' (уже была открыта)'}`,
      );
      return approvalRef(approval.id);
    },
  },
};


// ---------------------------------------------------------------------------
// server: has enough work piled up to be worth a release?
// ---------------------------------------------------------------------------

/** How many accepted features a release waits for, when the node does not say. */
const DEFAULT_RELEASE_MIN_COUNT = 3;

/** Upper bound on one assembly, so a flow that has not run for a quarter does not merge a quarter. */
const DEFAULT_RELEASE_LIMIT = 20;

/**
 * The branch a task's work actually reached, or `null` when it never reached one.
 *
 * Read off `AgentWorkspaceProposal` rather than off the run: the proposal is the record that knows
 * a branch was *pushed*, and only a pushed branch can be merged. A task whose proposal is still
 * waiting for review has a target branch too — and merging that would release work nobody applied.
 */
async function pushedBranchOf(taskId: string): Promise<string | null> {
  const proposal = await AgentWorkspaceProposal.findOne({
    where: { taskId, status: 'pushed' },
    order: [['updatedAt', 'DESC']],
  });
  const branch = proposal?.targetBranch?.trim();
  return branch ? branch : null;
}

export const tasksQueryNode: NodeTypeDefinition = {
  type: 'agentiz.tasks.query',
  name: 'Сколько накопилось задач',
  description: 'Считает готовые к релизу задачи проекта; два выхода — набралось и ещё нет',
  docs: tasksQueryDocs,
  category: 'Agentiz',
  kind: 'server',
  ports: { inputs: 1, outputs: ['enough', 'notEnough'] },
  configSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        title: 'Проект (id)',
        description: 'Обязателен: считать «сколько накопилось» по всем проектам сразу нечего',
      },
      workflowStatus: {
        type: 'string',
        title: 'Текстовый статус',
        description: 'Точное совпадение со статусом, который пишет узел «Статус задачи». Например: принято',
      },
      minCount: {
        type: 'number',
        title: 'Сколько ждать',
        description: `Порог. По умолчанию ${DEFAULT_RELEASE_MIN_COUNT}`,
      },
      limit: {
        type: 'number',
        title: 'Не больше чем',
        description: `Сколько задач максимум забрать в одну сборку. По умолчанию ${DEFAULT_RELEASE_LIMIT}`,
      },
    },
  },
  executor: {
    async execute(ctx: NodeContext): Promise<NodeResult> {
      const projectId = String(ctx.config.projectId ?? '').trim();
      if (!projectId) throw new Error('agentiz.tasks.query: не указан проект');
      const workflowStatus = String(ctx.config.workflowStatus ?? '').trim();
      if (!workflowStatus) throw new Error('agentiz.tasks.query: не указан текстовый статус');
      const configuredMin = Number(ctx.config.minCount ?? NaN);
      const minCount = Number.isFinite(configuredMin) && configuredMin > 0
        ? Math.floor(configuredMin)
        : DEFAULT_RELEASE_MIN_COUNT;
      const configuredLimit = Number(ctx.config.limit ?? NaN);
      const limit = Number.isFinite(configuredLimit) && configuredLimit > 0
        ? Math.floor(configuredLimit)
        : DEFAULT_RELEASE_LIMIT;

      // Oldest acceptance first: a release drains the queue, it does not skim it.
      const candidates = await AgentTask.findAll({
        where: { projectId, workflowStatus },
        order: [['workflowStatusAt', 'ASC']],
        limit,
      });

      const tasks: Array<{ taskId: string; title: string; branch: string }> = [];
      for (const task of candidates) {
        const branch = await pushedBranchOf(task.id);
        // Accepted but never pushed is not "almost ready" — there is nothing to merge, and letting
        // it into the count would make the release one feature short of what it promised.
        if (!branch) {
          ctx.logger.warn(`[agentiz.tasks.query] задача ${task.id} со статусом «${workflowStatus}» без запушенной ветки — пропущена`);
          continue;
        }
        tasks.push({ taskId: task.id, title: task.title, branch });
      }

      const payload = {
        ...(ctx.msg.payload as Record<string, unknown> | undefined),
        projectId,
        workflowStatus,
        minCount,
        count: tasks.length,
        tasks,
        taskIds: tasks.map((item) => item.taskId),
        branches: tasks.map((item) => item.branch),
      };
      const enough = tasks.length >= minCount;
      ctx.logger.info(
        `[agentiz.tasks.query] проект ${projectId}, «${workflowStatus}»: ${tasks.length} из ${minCount}`,
      );
      // Not enough is an ordinary outcome, not a failure: the schedule wakes this flow far more
      // often than work accumulates.
      return { msg: { ...ctx.msg, payload }, output: enough ? 'enough' : 'notEnough' };
    },
  },
};

// ---------------------------------------------------------------------------
// server: give a scheduled flow a task of its own
// ---------------------------------------------------------------------------

export const taskCreateNode: NodeTypeDefinition = {
  type: 'agentiz.task.create',
  name: 'Создать задачу',
  description: 'Заводит задачу — то, к чему флоу по расписанию привяжет запуск, статус и заявку',
  docs: taskCreateDocs,
  category: 'Agentiz',
  kind: 'server',
  ports: { inputs: 1, outputs: ['out'] },
  configSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        title: 'Проект (id)',
        description: 'Пусто = проект из msg.payload.projectId',
      },
      title: {
        type: 'string',
        title: 'Название',
        description: 'Шаблон. Подстановки: {{payload.count}}, {{payload.branches}}',
      },
      description: {
        type: 'string',
        title: 'Описание',
        description:
          'Шаблон. Попадает в промпт агента, поэтому список веток стоит выписать сюда:'
          + ' {{payload.branches}}',
      },
      tags: {
        type: 'string',
        title: 'Теги',
        description:
          'Через запятую. Задайте теги, по которым основной граф проекта задачу НЕ подхватит —'
          + ' иначе релизная задача запустит круг разработки',
      },
    },
  },
  executor: {
    async execute(ctx: NodeContext): Promise<NodeResult> {
      const previous = (ctx.msg.payload as Record<string, unknown> | undefined) ?? {};
      const projectId = String(ctx.config.projectId ?? previous.projectId ?? '').trim();
      if (!projectId) throw new Error('agentiz.task.create: не указан проект');
      const title = renderTemplate(ctx.config.title, ctx.msg).trim();
      if (!title) throw new Error('agentiz.task.create: название пусто');

      const created = await AgentTaskService.create(
        {
          projectId,
          title: title.slice(0, 250),
          description: renderTemplate(ctx.config.description, ctx.msg).trim() || undefined,
          tags: stringList(ctx.config.tags),
        },
        // The flow is the author. A workflow acting as a named person would put that person's name
        // on work they never asked for.
        { id: null, name: 'workflow' },
      );
      const taskId = String(created.id ?? '');
      if (!taskId) throw new Error('agentiz.task.create: задача создана без id');

      ctx.logger.info(`[agentiz.task.create] проект ${projectId}: задача ${taskId} «${title}»`);
      return {
        msg: {
          ...ctx.msg,
          payload: {
            ...previous,
            // Downstream nodes act on the new task — that is the whole point of creating it. The
            // list the flow arrived with is kept beside it so the last node can still mark every
            // task that went into this assembly.
            taskId,
            projectId,
            title,
            releaseTaskId: taskId,
            sourceTaskIds: previous.taskIds ?? [],
          },
        },
      };
    },
  },
};

export const agentizWorkflowNodes: NodeTypeDefinition[] = [
  taskEventTriggerNode,
  taskMatchNode,
  taskRunNode,
  pipelineNode,
  taskStatusNode,
  taskCommentNode,
  approvalNode,
  tasksQueryNode,
  taskCreateNode,
];
