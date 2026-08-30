import {
  activityTypeDef,
  type ActivityDashboardMode,
  type ActivityPushMode,
} from '../../app-agentiz/lib/notifications/activityTypes';
import {
  effectiveActivityPolicyExplained,
  type ActivityPolicyScopeName,
} from '../../app-agentiz/lib/notifications/policySettings';
import type { AgentProject } from '../../app-agentiz/models/AgentProject';
import type { AgentRun } from '../../app-agentiz/models/AgentRun';
import type { AgentRunDiff } from '../../app-agentiz/models/AgentRunDiff';
import type { AgentRunInteraction } from '../../app-agentiz/models/AgentRunInteraction';
import type { AgentTask } from '../../app-agentiz/models/AgentTask';
import type { AgentApprovalRequest } from '../../app-agentiz/models/AgentApprovalRequest';
import type { AgentWorkspaceProposal } from '../../app-agentiz/models/AgentWorkspaceProposal';

/**
 * One shape for everything that is waiting on a person.
 *
 * The app used to receive three differently-shaped arrays (questions, proposals, held diffs) and
 * invent the chips and the button captions for each of them in Kotlin, which is how "ревью" ended
 * up meaning nothing in particular on a card whose body was the agent's opening sentence. Here a
 * row carries the four things a decision needs — what kind of attention it is (`badge`, spelled by
 * `activityTypes.ts`, the same catalogue the notification policy is generated from), what is being
 * asked (`headline`), the facts to decide on (`facts`) and what the choices actually do
 * (`explain`) — plus the actions the client is allowed to offer. Nothing here is the agent's prose:
 * `facts` is files/branches/errors, never a summary.
 *
 * The entity ids stay on the row because the actions are the existing endpoints
 * (`/interactions/:id/answer`, `/proposals/:id/approve|reject`, `/tasks/:id/run`) — this is a
 * projection for reading, not a new write surface.
 */
export type InboxItemKind =
  | 'question'
  /**
   * A person has to accept the work itself, or send it back with a reason — the human gate of a
   * workflow (`AgentApprovalRequest`). Blocking: a whole flow is parked on it and only a decision
   * moves it, so it is counted and cannot be dismissed. Distinct from `review`, which is about a
   * *diff* waiting to be committed: here nothing is held in a worker's directory, and the question
   * is whether the feature is right.
   */
  | 'approval'
  | 'review'
  /**
   * A review with nothing to review: the run finished without touching a file, so approve is
   * closed for good and the only thing left is that the worker's directory is still reserved.
   * Its own kind rather than a `review` with two buttons missing, because the question a person
   * has to answer is a different one — not "коммитить ли это", but "работа не сделана, отпускаем".
   */
  | 'no_changes'
  | 'push_failed'
  | 'reset_failed'
  | 'held_diff'
  | 'run_failed'
  | 'pr';

export type InboxActionKey =
  | 'answer'
  | 'approve'
  | 'reject'
  | 'apply_diff'
  | 'rerun'
  | 'open_run'
  | 'open_url'
  /**
   * "Прочитал, делать ничего не буду" — the exit from a row that holds nothing and that nothing
   * else will ever close. Offered only where [InboxItem.dismissible] is true; see the field.
   */
  | 'dismiss'
  | 'restore';

export interface InboxAction {
  key: InboxActionKey;
  label: string;
  style: 'primary' | 'default' | 'danger';
}

/**
 * How this row's event is delivered right now, and where that was decided.
 *
 * The inbox and the notification policy are two views of one thing — a row is here *because* an
 * event of this type was recorded, and whether that event also woke anybody is the policy's
 * decision. Saying so on the row is what makes "почему мне не пришёл пуш" answerable where the
 * question is asked, and it is what lets the same row offer the switch: `scope` names the exact
 * rule in force, so turning it off from the inbox edits the entry a person would otherwise have
 * had to find on the settings screen.
 *
 * Delivery is per **type**, never per row: silencing this row silences every future event of the
 * same type in the same scope, which is the honest description of what the policy can express.
 */
export interface InboxNotify {
  /** The catalogue's own name for the event — «Запуск завершился с ошибкой». */
  typeLabel: string;
  push: ActivityPushMode;
  dashboard: ActivityDashboardMode;
  /** Which scope decided `push`, and whether it did so through that scope's `mute: true`. */
  scope: ActivityPolicyScopeName;
  mutedByScope: boolean;
  /** The pipeline scope this row resolved against, when its run had one — the client edits it. */
  pipelineSpecId: string | null;
  /** One line for the row: «пуш выключен правилом проекта». */
  label: string;
}

export interface InboxItem {
  /** Stable across refreshes and unique across kinds — the list key on the client. */
  id: string;
  kind: InboxItemKind;
  /** The catalogue entry this maps to: the badge's source, and the policy scope it is muted by. */
  activityType: string;
  badge: string;
  headline: string;
  facts: string | null;
  /**
   * What is going on and what each action does to it, in two sentences at most.
   *
   * `headline` says what happened and `facts` are the numbers to decide on; neither tells a reader
   * who has never seen a workspace proposal what pressing «Отклонить» will do to their files. That
   * sentence is written **here**, on the server, for the same reason the badge and the button
   * captions are: it has to be identical wherever the item is rendered, and a client is the wrong
   * place to be inventing an explanation of a server-side state machine.
   */
  explain: string | null;
  projectId: string;
  projectName: string | null;
  taskId: string | null;
  taskTitle: string | null;
  runId: string | null;
  interactionId: string | null;
  proposalId: string | null;
  revision: number | null;
  url: string | null;
  /** When this started waiting — the "ждёт 2 ч" label and the within-group order. */
  waitingSince: Date | null;
  expiresAt: Date | null;
  /** Sort group; see [sortInboxItems]. */
  priority: number;
  /**
   * Whether this row may be closed by simply reading it.
   *
   * True exactly for the **reminders** — a row that holds nothing (a failed run, an opened pull
   * request). Those are the ones nothing in Agentiz ever resolves, so without this they stay on
   * the screen forever and a person learns to ignore the whole list. A **blocking** row is never
   * dismissible: it holds an agent's turn or a worker's directory, and hiding it would leave the
   * next run failing on a reservation with the explanation gone from view. Its exit is its own
   * entity — answer, approve, reject, release.
   */
  dismissible: boolean;
  /** Set only on a row the caller has dismissed and asked to see anyway. */
  dismissedAt: Date | null;
  /** Delivery of this row's event, and the rule that decided it. */
  notify: InboxNotify;
  actions: InboxAction[];
}

/**
 * Who blocks whom, in that order: a question holds an agent mid-turn; a failed push, a failed reset
 * and a proposal nobody can approve all hold a worker's directory, so every later run on that path
 * fails until a person acts; a review holds the change itself; a held diff waits to be applied.
 * Below them sit the two **reminders** — a failed run and an opened pull request hold nothing at
 * all, and nothing in Agentiz resolves them.
 */
const PRIORITY: Record<InboxItemKind, number> = {
  question: 0,
  push_failed: 1,
  reset_failed: 1,
  no_changes: 1,
  review: 2,
  // Below a diff review and above a held diff: it holds a workflow rather than a directory, so
  // nothing else fails while it waits — but it is the last step of a feature and a person is
  // explicitly expected.
  approval: 3,
  held_diff: 4,
  run_failed: 5,
  pr: 6,
};

/**
 * The kinds that actually hold something — an agent's turn, a worker's directory, a change waiting
 * to be applied. They are what `actionableCount` and the app-icon badge count, and they never go
 * away by themselves: only their own entity closes them.
 *
 * The other two are reminders. They are shown, they are useful, and they are deliberately **not**
 * counted: nothing local resolves a pull request or a run that failed for good, so counting them
 * would make the number on the icon grow forever until it stopped meaning anything.
 */
const BLOCKING: ReadonlySet<InboxItemKind> = new Set<InboxItemKind>([
  'question', 'push_failed', 'reset_failed', 'no_changes', 'review', 'held_diff', 'approval',
]);

export function isBlockingInboxItem(item: InboxItem): boolean {
  return BLOCKING.has(item.kind);
}

export interface InboxContext {
  task?: AgentTask | null;
  project?: AgentProject | null;
  /**
   * The pipeline the row's run came from (`AgentRun.pipelineSpecId`), when there is one.
   *
   * Only used to resolve the notification policy the way the dispatcher resolved it for the push:
   * a row must not claim "пуш включён" while the pipeline scope has the type switched off.
   */
  pipelineSpecId?: string | null;
}

/** First non-empty line, collapsed and clipped — a card gives any of these two lines at most. */
function firstLine(text: string | null | undefined, max = 160): string | null {
  if (!text) return null;
  const line = text.split('\n').map((part) => part.trim()).find((part) => part.length > 0);
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function join(parts: Array<string | null | undefined>): string | null {
  const kept = parts.filter((part): part is string => typeof part === 'string' && part.length > 0);
  return kept.length > 0 ? kept.join(' · ') : null;
}

/** `3 файла · +48/−12`, or the operation count when the worker sent no stats. */
function diffFacts(diff: AgentRunDiff | null | undefined): string | null {
  if (!diff) return null;
  const stats = diff.stats;
  if (stats) return `${stats.files} файл(ов) · +${stats.insertions}/−${stats.deletions}`;
  const operations = diff.ops?.length ?? 0;
  return operations > 0 ? `${operations} операций` : null;
}

/** Where a workspace proposal's files live, in the words the worker screen uses. */
function workspaceName(proposal: AgentWorkspaceProposal): string {
  return proposal.workspaceKey || proposal.workspacePath || 'воркспейс';
}

/** «пуш выключен правилом проекта» — the value and the rule that produced it, in one line. */
function notifyLabel(notify: Omit<InboxNotify, 'label'>): string {
  const state = notify.push === 'on' ? 'пуш включён'
    : notify.push === 'silent' ? 'пуш без звука'
      : 'пуш выключен';
  const by = notify.scope === 'pipeline' ? 'правилом пайплайна'
    : notify.scope === 'project' ? 'правилом проекта'
      : notify.scope === 'defaults' ? 'общим правилом'
        : 'по умолчанию';
  return `${state} ${by}`;
}

/**
 * The delivery state of one row, resolved exactly as `ActivityService.record()` resolved it when
 * the event happened — same function, same scope chain. A row that says something else about its
 * own notification is worse than a row that says nothing.
 */
function notifyOf(activityType: string, projectId: string, context: InboxContext): InboxNotify {
  const pipelineSpecId = context.pipelineSpecId ?? null;
  const explained = effectiveActivityPolicyExplained(activityType, projectId, pipelineSpecId);
  const notify = {
    typeLabel: activityTypeDef(activityType).label,
    push: explained.push.mode,
    dashboard: explained.dashboard.mode,
    scope: explained.push.scope,
    mutedByScope: explained.push.byMute,
    pipelineSpecId,
  };
  return { ...notify, label: notifyLabel(notify) };
}

function base(kind: InboxItemKind, activityType: string, context: InboxContext, projectId: string) {
  const def = activityTypeDef(activityType);
  return {
    kind,
    activityType,
    badge: def.badge,
    dismissible: !BLOCKING.has(kind),
    dismissedAt: null as Date | null,
    notify: notifyOf(activityType, projectId, context),
    projectName: context.project?.name ?? null,
    taskId: context.task?.id ?? null,
    taskTitle: context.task?.title ?? null,
    priority: PRIORITY[kind],
    interactionId: null as string | null,
    proposalId: null as string | null,
    revision: null as number | null,
    url: null as string | null,
    expiresAt: null as Date | null,
    explain: null as string | null,
  };
}

export function questionItem(
  interaction: AgentRunInteraction,
  context: InboxContext & { run?: AgentRun | null; stageRole?: string | null },
): InboxItem {
  return {
    ...base('question', 'interaction.created', context, interaction.projectId),
    id: `question:${interaction.id}`,
    headline: firstLine(interaction.message) ?? 'Агент ждёт ответа',
    facts: join(['Запуск на паузе', context.stageRole ? `этап ${context.stageRole}` : null]),
    explain: 'Агент остановился посреди работы и ждёт ответа. Пока вы не ответите, запуск стоит'
      + ' и ничего не делает.',
    projectId: interaction.projectId,
    taskId: context.task?.id ?? context.run?.taskId ?? null,
    runId: interaction.runId,
    interactionId: interaction.id,
    waitingSince: interaction.createdAt ?? null,
    expiresAt: interaction.expiresAt ?? null,
    // Answering happens against the interaction's own schema, so the client opens its form rather
    // than acting from the card: the caption is the same either way.
    actions: [{ key: 'answer', label: 'Ответить', style: 'primary' }],
  };
}

export function proposalItem(
  proposal: AgentWorkspaceProposal,
  context: InboxContext & { diff?: AgentRunDiff | null; approvable?: boolean },
): InboxItem {
  const unreviewable = proposal.status === 'waiting_review' && context.approvable === false;
  const kind: InboxItemKind = proposal.status === 'push_failed' ? 'push_failed'
    : proposal.status === 'reset_failed' ? 'reset_failed'
      : unreviewable ? 'no_changes'
        : 'review';
  const activityType = kind === 'push_failed' ? 'proposal.push_failed'
    : kind === 'reset_failed' ? 'proposal.reset_failed'
      : 'proposal.waiting_review';
  const facts = join([
    diffFacts(context.diff),
    proposal.targetBranch ? `ветка ${proposal.targetBranch}` : null,
    `ревизия ${proposal.revision}`,
  ]);
  const error = firstLine(proposal.lastError);
  const where = workspaceName(proposal);
  const actions: InboxAction[] = [];
  if (kind === 'review') {
    actions.push({ key: 'approve', label: 'Одобрить…', style: 'primary' });
  }
  if (kind === 'push_failed') {
    actions.push({ key: 'approve', label: 'Повторить push…', style: 'primary' });
  }
  if (kind === 'no_changes') {
    // The agent's text answer *is* the result here, so reading it is the primary move; the folder
    // is freed second. Deliberately no «Запустить ещё раз»: the workspace is still reserved by
    // this proposal, so a re-run would be refused until it is released.
    actions.push({ key: 'open_run', label: 'Открыть ответ агента', style: 'primary' });
  }
  actions.push({
    key: 'reject',
    label: kind === 'reset_failed' ? 'Повторить сброс…'
      : kind === 'no_changes' ? 'Освободить папку'
        : 'Отклонить…',
    // Nothing is destroyed by any of these (a rejection stashes first), but «Отклонить» on a real
    // diff is still the decision to throw work away, and «Освободить папку» on an empty one is
    // simple housekeeping — they must not look equally alarming.
    style: kind === 'review' || kind === 'push_failed' ? 'danger' : 'default',
  });
  const explain = kind === 'review'
    ? `Изменения лежат в папке воркера (${where}) и никуда не поедут сами.`
      + ` «Одобрить» — закоммитить их${proposal.targetBranch ? ` в ветку ${proposal.targetBranch}` : ''} и запушить.`
      + ' «Отклонить» — вернуть папку к исходному состоянию; изменения при этом не пропадают, воркер'
      + ' сначала кладёт их в git stash.'
    : kind === 'no_changes'
      ? `Запуск закончился, но ни одного файла не изменил — одобрять нечего, поэтому кнопки «Одобрить» нет.`
        + ' Скорее всего агента просили что-то посмотреть или проверить, и ответ лежит в результате'
        + ` запуска. Папка воркера (${where}) остаётся занятой этим ревью: пока её не освободить,`
        + ' следующий запуск в ней не стартует.'
      : kind === 'push_failed'
        ? `Коммит собрался, но push не прошёл${error ? `: ${error}` : ''}.`
          + ' «Повторить push» пробует ещё раз с теми же изменениями — имеет смысл, если причина'
          + ` устранена (доступы, ветка на сервере). «Отклонить» вернёт папку (${where}) к исходному`
          + ' состоянию, изменения уедут в git stash.'
        : `Папку воркера (${where}) не удалось вернуть к исходному состоянию${error ? `: ${error}` : ''}.`
          + ' Пока это не пройдёт, папка остаётся занятой и следующий запуск в ней не стартует.'
          + ' «Повторить сброс» ставит ту же операцию заново.';
  return {
    ...base(kind, activityType, context, proposal.projectId),
    id: `proposal:${proposal.id}`,
    // The catalogue names the *event* ("изменения ждут ревью"); when the state of that event makes
    // the name a lie, the badge is narrowed here — still one server-side place, so the phone, the
    // panel and the next channel keep saying the same thing.
    badge: kind === 'no_changes' ? 'без изменений' : activityTypeDef(activityType).badge,
    // A failure explains itself; a review is named by what it would commit.
    headline: kind === 'review'
      ? firstLine(proposal.commitMessage) ?? 'Изменения ждут ревью'
      : kind === 'no_changes'
        ? 'Запуск ничего не изменил'
        : error ?? (kind === 'push_failed' ? 'Push не прошёл' : 'Сброс воркспейса не прошёл'),
    facts,
    explain,
    projectId: proposal.projectId,
    taskId: proposal.taskId,
    runId: proposal.latestRunId,
    proposalId: proposal.id,
    revision: proposal.revision,
    waitingSince: proposal.updatedAt ?? null,
    actions,
  };
}

export function heldDiffItem(diff: AgentRunDiff, run: AgentRun, context: InboxContext): InboxItem {
  const operations = diff.ops?.length ?? 0;
  return {
    ...base('held_diff', 'run.held_for_approval', context, run.projectId),
    id: `held:${diff.id}`,
    headline: operations === 1 ? '1 изменение ждёт одобрения' : `${operations} изменений ждут одобрения`,
    facts: diffFacts(diff),
    explain: 'Пайплайн настроен так, что изменения не уезжают без человека: они уже посчитаны и'
      + ' лежат в Agentiz. «Применить» закоммитит и запушит их так же, как это сделал бы сам'
      + ' пайплайн; повторно применить один и тот же дифф нельзя.',
    projectId: run.projectId,
    taskId: run.taskId,
    runId: run.id,
    waitingSince: run.finishedAt ?? run.createdAt ?? null,
    actions: [
      { key: 'apply_diff', label: 'Применить изменения', style: 'primary' },
      { key: 'open_run', label: 'Посмотреть дифф', style: 'default' },
    ],
  };
}

/**
 * A decision waiting for a person: the human gate of a workflow.
 *
 * `facts` are the facts, as everywhere in this file — the agent's machine verdict and its reason,
 * the run it came from, how many links there are to look at — never the agent's prose. The
 * verdict is exactly what belongs here: it is the one line that says whether the machine thinks
 * the work is done, and it is what a person checks the links against.
 *
 * `explain` spells out what each button does, because the two do very different things: one ends
 * the flow with the work accepted, the other sends the task back to the developer with the text
 * the person types as the agent's next instruction. That is also why «Отклонить…» carries an
 * ellipsis — the client must ask for the text, and the endpoint refuses a rejection without it.
 */
export function approvalItem(
  approval: AgentApprovalRequest,
  context: InboxContext & { verdict?: 'pass' | 'fail' | null; verdictReason?: string | null },
): InboxItem {
  const linkCount = approval.links?.length ?? 0;
  const verdict = context.verdict
    ? `вердикт агента: ${context.verdict === 'pass' ? 'ок' : 'не ок'}`
    : null;
  return {
    ...base('approval', 'approval.requested', context, approval.projectId),
    id: `approval:${approval.id}`,
    headline: approval.title,
    facts: join([
      verdict,
      context.verdict === 'fail' ? firstLine(context.verdictReason, 120) : null,
      linkCount > 0 ? `${linkCount} ссыл${linkCount === 1 ? 'ка' : 'ок'} для проверки` : null,
    ]),
    explain: 'Работа дошла до вас: посмотрите по ссылкам и решите.'
      + ' «Принять» — задача считается принятой и воркфлоу идёт дальше.'
      + ' «Отклонить» — нужен текст: он уедет разработчику как задание на доработку, и по задаче'
      + ' начнётся новый круг. Пока решения нет, воркфлоу стоит.',
    projectId: approval.projectId,
    taskId: approval.taskId,
    runId: approval.runId,
    url: approval.links?.[0]?.url ?? null,
    waitingSince: approval.createdAt ?? null,
    actions: [
      { key: 'approve', label: 'Принять', style: 'primary' },
      { key: 'reject', label: 'Отклонить…', style: 'danger' },
    ],
  };
}

/**
 * What a failure was, in words, when we recognise it.
 *
 * `run.errorMessage` is written for whoever is debugging: it carries the HTTP verb, the job id and
 * sometimes a JSON body, and as a headline it is unreadable. The vocabulary here is deliberately
 * tiny and anything unrecognised falls through to the raw first line — inventing a category for an
 * error we do not know is worse than showing the text, because a wrong category sends the reader
 * looking in the wrong place. The raw line is never lost either way: it becomes the row's `facts`.
 */
function runFailureHeadline(error: string | null): string {
  if (!error?.trim()) return 'Запуск завершился с ошибкой';
  if (/(session|usage|rate) limit/i.test(error)) return 'Упёрся в лимит подписки';
  if (/is reserved by proposal/i.test(error)) return 'Папка воркера была занята другим ревью';
  if (/^(POST|GET|PUT|DELETE)\s+\/jobs\/.*HTTP\s+\d{3}/i.test(error)) return 'Воркер не смог отчитаться серверу';
  if (/no worker|not claimed|requiredWorkerId/i.test(error)) return 'Задание никто не взял в работу';
  return firstLine(error) ?? 'Запуск завершился с ошибкой';
}

/**
 * A run that ended in a failure nobody has answered yet.
 *
 * Nothing is reserved by it — it is a **reminder**, not a block: the task simply did not get done,
 * and only a person decides whether to try again. Nothing in Agentiz closes it, which is why it is
 * outside `actionableCount` and sinks in the list as newer rows arrive instead of expiring on a
 * timer. Restricted to the **latest** run of a task by its callers, so a task that failed six times
 * is one row, not six.
 */
export function runFailureItem(run: AgentRun, context: InboxContext): InboxItem {
  const error = firstLine(run.errorMessage);
  return {
    ...base('run_failed', 'run.failed', context, run.projectId),
    id: `run:${run.id}`,
    // Classified on the whole message, not on the line shown: the recognisable part of a worker
    // error is often on the second line.
    headline: runFailureHeadline(run.errorMessage ?? null),
    // The diagnostic text stays on the row — one line below the human wording, where a raw HTTP
    // body is information rather than a title.
    facts: firstLine(run.errorMessage, 120),
    explain: 'Задача осталась несделанной, и сама она больше ничего не предпримет.'
      + ' «Запустить ещё раз» повторит пайплайн с тем же заданием. Ничего решать прямо сейчас не'
      + ' обязательно: строка не блокирует ничью работу и со временем уйдёт вниз списка.',
    projectId: run.projectId,
    taskId: run.taskId,
    runId: run.id,
    waitingSince: run.finishedAt ?? run.createdAt ?? null,
    actions: [
      { key: 'rerun', label: 'Запустить ещё раз', style: 'primary' },
      { key: 'open_run', label: 'Открыть лог', style: 'default' },
    ],
  };
}

export function pullRequestItem(
  input: { id: string; projectId: string; url: string | null; createdAt: Date | null; runId: string | null },
  context: InboxContext,
): InboxItem {
  return {
    ...base('pr', 'pr.opened', context, input.projectId),
    id: `pr:${input.id}`,
    headline: 'Открыт pull request',
    facts: input.url,
    explain: 'Дальше всё происходит на стороне гита: влить или закрыть PR Agentiz не может и не'
      + ' узнаёт, что с ним стало. Это напоминание, а не задача с решением: оно никого не держит и'
      + ' со временем уйдёт вниз списка.',
    projectId: input.projectId,
    taskId: context.task?.id ?? null,
    runId: input.runId,
    url: input.url,
    waitingSince: input.createdAt,
    actions: input.url ? [{ key: 'open_url', label: 'Открыть PR', style: 'primary' }] : [],
  };
}

/**
 * The sort group a dismissed row moves to: under everything, in the order it was hidden.
 *
 * Higher than every kind's own priority on purpose — a hidden row is only ever visible because the
 * reader asked to see hidden rows, and it must not push a live one down while they look.
 */
const DISMISSED_PRIORITY = 9;

/**
 * The "прочитал, делать ничего не буду" exit, applied to a row that has one.
 *
 * Two rules, both from the design of the list: only a reminder may be dismissed (a blocking row
 * holds something, and hiding it hides the reason the next run will fail), and dismissal is
 * per person and per row — it closes *this* failure, not the task and not the type. A task that
 * fails again produces a new run, hence a new row id, hence a new row: nothing here can silence a
 * future problem, which is what the notification policy is for.
 */
export function applyDismissal(item: InboxItem, dismissedAt: Date | null): InboxItem {
  if (!item.dismissible) return item;
  if (dismissedAt) {
    return {
      ...item,
      dismissedAt,
      priority: DISMISSED_PRIORITY,
      explain: join2(
        'Скрыто вами: строка не показывается во входящих и ни на что не влияет.',
        item.explain,
      ),
      actions: [
        ...item.actions.filter((action) => action.key !== 'dismiss'),
        { key: 'restore', label: 'Вернуть в список', style: 'default' },
      ],
    };
  }
  return {
    ...item,
    explain: join2(
      item.explain,
      'Если разбираться не планируете — «Не требует действий» уберёт строку из входящих; запуск,'
      + ' задача и лента останутся как есть, а следующая такая же ошибка придёт заново.',
    ),
    actions: [...item.actions, { key: 'dismiss', label: 'Не требует действий', style: 'default' }],
  };
}

function join2(...parts: Array<string | null>): string | null {
  const kept = parts.filter((part): part is string => Boolean(part && part.length > 0));
  return kept.length > 0 ? kept.join(' ') : null;
}

/**
 * Order: `priority` first, then time — but the direction of *time* depends on what the row is.
 *
 * Something that is blocking is sorted oldest-first: the one ignored longest is the one to deal
 * with, and it must climb, not sink. A reminder is sorted the other way, newest first, because it
 * is never resolved by anybody — it is only superseded. That is what makes "старое просто уходит
 * вниз и перестаёт попадаться на глаза" work without any expiry rule: nothing is hidden by a
 * timer, it just stops being near the top.
 */
export function sortInboxItems(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const left = a.waitingSince ? new Date(a.waitingSince).getTime() : 0;
    const right = b.waitingSince ? new Date(b.waitingSince).getTime() : 0;
    return isBlockingInboxItem(a) ? left - right : right - left;
  });
}
