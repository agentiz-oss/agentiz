import type { AgentTask } from '../../models/AgentTask';

/**
 * The facts app-agentiz puts on the app-manager emitter so a workflow can react to them.
 *
 * The workflow engine listens to the raw string-key emitter (`AppManagerEventBus`), so the key is
 * the contract and the `AbstractEvent` classes below exist for the *catalogue*: an app's `events`
 * collection is what fills `emitter.getAllEvents()`, which is what the canvas offers as a dropdown
 * when a trigger names an event. Emitting without declaring would work and show up nowhere.
 *
 * Only task arrival/edits are emitted today — that is what the first flow needs. Everything else
 * in the plan (run outcomes, proposals, worker state) belongs on `ActivityService.record()`, the
 * single dispatcher for "a person may care", and is deliberately not started here.
 */
export const AGENTIZ_TASK_CREATED = 'agentiz.task.created';
export const AGENTIZ_TASK_UPDATED = 'agentiz.task.updated';
/**
 * The second input of the human-in-the-loop graph
 * (`.ai-notes/human-in-the-loop-workflow-plan.md` §9): a remark landed in the task's thread.
 * Fired for every comment, whoever wrote it — a comment that is a run's own report (`runId` set)
 * is not filtered out here, because the event is a fact about the thread, not a decision about
 * who should react to it. The decision "don't wake on our own report" belongs to whatever listens
 * (the `agentiz.task.trigger` node's second input), the same way `authorKind`/`maxRounds` do.
 */
export const AGENTIZ_TASK_COMMENTED = 'agentiz.task.commented';

/** What a trigger node hands the graph as `msg.payload`. Flat on purpose: the nodes read paths. */
export interface AgentizTaskEventPayload {
  taskId: string;
  projectId: string;
  title: string;
  description: string | null;
  tags: string[];
  status: string;
  priority: string;
  externalId: string;
  externalUrl: string | null;
  sourceType: string | null;
  /** Only on `agentiz.task.updated`: which of the watched fields the save touched. */
  changed?: string[];
}

/** What a trigger node hands the graph as `msg.payload` for `agentiz.task.commented`. */
export interface AgentizTaskCommentedPayload extends AgentizTaskEventPayload {
  commentId: string;
  authorKind: string;
  authorName: string | null;
  origin: string;
  /** Set when the comment is a run's own report to the thread — see the constant's doc comment. */
  runId: string | null;
  body: string;
  /**
   * The comment asked not to wake anything (`meta.silent`).
   *
   * Written by the workflow's own bookkeeping — the note `agentiz.task.status` leaves in the
   * thread when it is told to — so that a flow narrating its own progress cannot be mistaken for
   * a remark somebody has to react to. Like `runId`, it is a fact about the comment, and what a
   * listener does with it is the listener's business; the trigger node treats both as hard rules.
   */
  silent: boolean;
}

/**
 * Not extending app-manager's `AbstractEvent`: that class lives in `dist/lib/AsyncEventEmitter`
 * and is not re-exported from the package root, and reaching into a dependency's file layout for
 * a base class with four abstract fields is a worse trade than declaring the four fields. The
 * `events` collection handler only instantiates the class and reads them.
 */
export class EventAgentizTaskCreated {
  key = AGENTIZ_TASK_CREATED;
  name = 'Agentiz: задача создана';
  description = 'Задача появилась в Agentiz — из синхронизации с трекером или заведена вручную';
  arguments = [Object];
}

export class EventAgentizTaskUpdated {
  key = AGENTIZ_TASK_UPDATED;
  name = 'Agentiz: задача изменена';
  description = 'У задачи изменилось название, описание или теги';
  arguments = [Object];
}

export class EventAgentizTaskCommented {
  key = AGENTIZ_TASK_COMMENTED;
  name = 'Agentiz: в задаче написали комментарий';
  description = 'В треде задачи появился комментарий — человека, агента или из внешнего трекера';
  arguments = [Object];
}

export const agentizWorkflowEvents = [EventAgentizTaskCreated, EventAgentizTaskUpdated, EventAgentizTaskCommented];

interface EmitterLike {
  emit(eventKey: string, payload: unknown): void;
}

interface AppManagerLike {
  emitter?: EmitterLike;
}

// Same tsx double-instantiation hazard as every other registry here — hence the global symbol.
const EMITTER_KEY = Symbol.for('agentiz.workflow.emitter');

function holder(): Record<symbol, AppManagerLike | null> {
  return globalThis as unknown as Record<symbol, AppManagerLike | null>;
}

/** Installed by the layer at mount. Until then (and in unit tests) emitting is a no-op. */
export function useWorkflowEvents(appManager: AppManagerLike): void {
  holder()[EMITTER_KEY] = appManager;
}

export function forgetWorkflowEvents(): void {
  holder()[EMITTER_KEY] = null;
}

export function taskEventPayload(task: AgentTask): AgentizTaskEventPayload {
  return {
    taskId: task.id,
    projectId: task.projectId,
    title: task.title,
    description: task.description ?? null,
    tags: Array.isArray(task.tags) ? task.tags.map((tag) => String(tag)) : [],
    status: task.status,
    priority: task.priority,
    externalId: task.externalId,
    externalUrl: task.externalUrl ?? null,
    sourceType: task.sourceType ?? null,
  };
}

/**
 * Fire-and-forget, and never the reason a write fails: this is called from a model hook that sits
 * inside whatever transaction created the task, and a workflow that cannot start is not a reason
 * to lose the task itself. Listeners are synchronous by EventEmitter's nature, so a trigger's own
 * work must not be done inline — the trigger node starts a run and returns.
 */
export function emitAgentizEvent(eventKey: string, payload: unknown): void {
  const emitter = holder()[EMITTER_KEY]?.emitter;
  if (!emitter) return;
  try {
    emitter.emit(eventKey, payload);
  } catch (error) {
    console.error(`[AppAgentiz] failed to emit "${eventKey}":`, error);
  }
}
