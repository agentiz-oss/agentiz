import type { AgentTask } from '../../models/AgentTask';
import type { GitProviderType } from '../../types/agentiz';

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

/**
 * Repository facts (`.ai-notes/repository-events-workflow-plan.md` §2): commits landed in a branch,
 * a CI run finished.
 *
 * Provider-neutral and emitted from the core (`lib/workflow/repositoryEvents.ts`) whichever source
 * observed them — the 15-minute poll or a webhook delivery — so a second platform contributes a
 * reader, not a second event. The payload carries `projectId` because every node here filters by
 * project; one repository linked to two projects therefore raises two events, one per active
 * `AgentProjectRepository`.
 */
export const AGENTIZ_REPOSITORY_PUSHED = 'agentiz.repository.pushed';
export const AGENTIZ_REPOSITORY_CI_RUN = 'agentiz.repository.ciRun';

/**
 * A package version of this repository was published — a container image tag, in practice.
 *
 * The one fact here with a **single** source, and deliberately so: the platform's hook is the only
 * thing that reports it (GitHub's `package`), while the poll behind the other two reads the git
 * API and knows nothing about registries. Reading a registry is a separate reader over the OCI
 * Distribution API with a cursor of its own, and until that exists a missed delivery of this fact
 * is lost rather than delayed — which is why there is no cursor for it here either: there is no
 * second observer to keep quiet.
 *
 * No attribution: an image carries no branch, so `ownRunId`/`taskId` are absent by construction
 * and a graph on this event guards itself with `skipIfFlowActive`/`maxRounds`, not with
 * `ignoreOwnRuns`.
 */
export const AGENTIZ_REPOSITORY_PACKAGE = 'agentiz.repository.packagePublished';

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

/** Which repository, in which project's copy of the event. Common to every repository fact. */
export interface AgentizRepositoryIdentity {
  projectId: string;
  /** `AgentRepository.id` — the mirror row, the same id for every project the repository reaches. */
  repositoryId: string;
  /** `AgentProjectRepository.id` — the link this copy of the event travelled through. */
  projectRepositoryId: string;
  provider: GitProviderType;
  pathWithNamespace: string;
  webUrl: string | null;
}

/** The half of a *branch* fact (push, CI) that does not depend on which of the two it is. */
export interface AgentizRepositoryEventPayload extends AgentizRepositoryIdentity {
  branch: string;
  /**
   * The run that produced this, when the branch is one of ours (§6).
   *
   * Matched on `AgentRun.branch` rather than on the sha: a person pushing one more commit onto the
   * agent's branch is still work that must not restart the flow that is already on it. The sha is
   * carried beside it as a fact, so a graph that wants the stricter reading can compare itself.
   */
  ownRunId: string | null;
  ownTaskId: string | null;
  /**
   * `ownTaskId` again, under the name every node downstream reads (`payloadOf` wants `taskId`).
   *
   * Absent for a push nobody's run made — and that is the normal case that `agentiz.task.create`
   * exists for. Present, it is what lets `agentiz.task.comment` write a failed CI straight into the
   * thread of the task whose run caused it, which is how the rework round closes through CI.
   */
  taskId?: string;
}

/** `agentiz.repository.pushed` — commits landed in a branch. */
export interface AgentizRepositoryPushedPayload extends AgentizRepositoryEventPayload {
  /** `null` = the branch is new; the commits are then those it does not share with the default one. */
  beforeSha: string | null;
  afterSha: string;
  forced: boolean;
  commits: Array<{ sha: string; message: string; author: string; url: string }>;
  compareUrl: string | null;
}

/** `agentiz.repository.ciRun` — a CI run of this repository finished, with its outcome. */
export interface AgentizRepositoryCiRunPayload extends AgentizRepositoryEventPayload {
  headSha: string;
  workflowName: string;
  conclusion: string;
  url: string;
  externalRunId: string;
}

/**
 * `agentiz.repository.packagePublished` — a package version appeared or moved.
 *
 * `tag`/`digest` are what a graph acts on and both may be empty: a package type that is not a
 * container has no tag, and a platform that reports the version without its manifest digest gives
 * none. Empty is passed on rather than guessed, and a filter naming a tag simply does not match.
 */
export interface AgentizRepositoryPackagePayload extends AgentizRepositoryIdentity {
  packageName: string;
  /** Lower case, the platform's own vocabulary: `container`, `npm`, `maven`, … */
  packageType: string;
  /** The owner the package hangs on — the org or user, not the repository. */
  namespace: string;
  /** `published` (a new version) or `updated` (the same version re-tagged or re-described). */
  action: string;
  /** The version as the platform names it; for a container that is usually the digest. */
  version: string;
  /** The image tag this version was published under, `''` when the platform reported none. */
  tag: string;
  /** `sha256:…`, `''` when the platform reported none. */
  digest: string;
  /** What you would `docker pull` — `ghcr.io/<ns>/<name>`, without the tag. */
  packageUrl: string;
  htmlUrl: string;
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

export class EventAgentizRepositoryPushed {
  key = AGENTIZ_REPOSITORY_PUSHED;
  name = 'Agentiz: в репозиторий пришли коммиты';
  description = 'В ветку подключённого к проекту репозитория запушили коммиты';
  arguments = [Object];
}

export class EventAgentizRepositoryCiRun {
  key = AGENTIZ_REPOSITORY_CI_RUN;
  name = 'Agentiz: завершился CI-прогон';
  description = 'Прогон CI подключённого репозитория закончился — с исходом (успех, падение, отмена)';
  arguments = [Object];
}

export class EventAgentizRepositoryPackage {
  key = AGENTIZ_REPOSITORY_PACKAGE;
  name = 'Agentiz: опубликован пакет репозитория';
  description = 'В реестре появилась новая версия пакета (для контейнеров — новый тег образа)';
  arguments = [Object];
}

export const agentizWorkflowEvents = [
  EventAgentizTaskCreated,
  EventAgentizTaskUpdated,
  EventAgentizTaskCommented,
  EventAgentizRepositoryPushed,
  EventAgentizRepositoryCiRun,
  EventAgentizRepositoryPackage,
];

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
