import { activityTypeDef } from '../../app-agentiz/lib/notifications/activityTypes';
import type { AgentProject } from '../../app-agentiz/models/AgentProject';
import type { AgentRun } from '../../app-agentiz/models/AgentRun';
import type { AgentRunDiff } from '../../app-agentiz/models/AgentRunDiff';
import type { AgentRunInteraction } from '../../app-agentiz/models/AgentRunInteraction';
import type { AgentTask } from '../../app-agentiz/models/AgentTask';
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
  | 'close_task'
  | 'open_run'
  | 'open_url';

export interface InboxAction {
  key: InboxActionKey;
  label: string;
  style: 'primary' | 'default' | 'danger';
  /**
   * The argument the endpoint takes, when the same action means different things on different
   * rows: «Закрыть задачу» is `done` for a merged pull request and `cancelled` for a run that will
   * not be retried. Deciding that on the client would put the meaning of a button in two places.
   */
  value?: string;
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
  actions: InboxAction[];
}

/**
 * Who blocks whom, in that order: a question holds an agent mid-turn; a failed push, a failed reset
 * and a proposal nobody can approve all hold a worker's directory, so every later run on that path
 * fails until a person acts; a failed run holds nothing but means the work did not happen; a review
 * holds only the change itself; a pull request holds nothing of ours at all. Time is the tiebreaker
 * inside a group, oldest first — the opposite of the feed, because here the oldest row is the one
 * that has been ignored longest.
 */
const PRIORITY: Record<InboxItemKind, number> = {
  question: 0,
  push_failed: 1,
  reset_failed: 1,
  no_changes: 1,
  run_failed: 2,
  review: 3,
  held_diff: 4,
  pr: 5,
};

export interface InboxContext {
  task?: AgentTask | null;
  project?: AgentProject | null;
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

function base(kind: InboxItemKind, activityType: string, context: InboxContext) {
  const def = activityTypeDef(activityType);
  return {
    kind,
    activityType,
    badge: def.badge,
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
    ...base('question', 'interaction.created', context),
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
    ...base(kind, activityType, context),
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
    ...base('held_diff', 'run.held_for_approval', context),
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
 * A run that ended in a failure nobody has answered yet.
 *
 * Nothing is *reserved* by it, so this is the one kind that waits on a decision rather than on a
 * release: either the task gets another attempt or it gets closed. Restricted to the **latest** run
 * of an open task by its callers — every earlier attempt of the same task is history, and a list
 * that grows by one row per failed attempt is a list nobody reads.
 */
export function runFailureItem(run: AgentRun, context: InboxContext): InboxItem {
  const error = firstLine(run.errorMessage);
  return {
    ...base('run_failed', 'run.failed', context),
    id: `run:${run.id}`,
    headline: error ?? 'Запуск завершился с ошибкой',
    facts: join([context.task?.status ? `задача: ${context.task.status}` : null]),
    explain: 'Задача осталась несделанной, и сама она больше ничего не предпримет.'
      + ' «Запустить ещё раз» повторит пайплайн с тем же заданием; если задача больше не нужна —'
      + ' закройте её, и строка уйдёт из входящих.',
    projectId: run.projectId,
    taskId: run.taskId,
    runId: run.id,
    waitingSince: run.finishedAt ?? run.createdAt ?? null,
    actions: [
      { key: 'rerun', label: 'Запустить ещё раз', style: 'primary' },
      { key: 'open_run', label: 'Открыть лог', style: 'default' },
      { key: 'close_task', label: 'Закрыть задачу', style: 'default', value: 'cancelled' },
    ],
  };
}

export function pullRequestItem(
  input: { id: string; projectId: string; url: string | null; createdAt: Date | null; runId: string | null },
  context: InboxContext,
): InboxItem {
  return {
    ...base('pr', 'pr.opened', context),
    id: `pr:${input.id}`,
    headline: 'Открыт pull request',
    facts: input.url,
    explain: 'Дальше всё происходит на стороне гита: влить или закрыть PR Agentiz не может и не'
      + ' узнаёт, что с ним стало. Когда разберётесь — закройте задачу, и строка уйдёт из входящих.',
    projectId: input.projectId,
    taskId: context.task?.id ?? null,
    runId: input.runId,
    url: input.url,
    waitingSince: input.createdAt,
    actions: [
      ...(input.url ? [{ key: 'open_url' as const, label: 'Открыть PR', style: 'primary' as const }] : []),
      { key: 'close_task', label: 'Закрыть задачу', style: 'default', value: 'done' },
    ],
  };
}

export function sortInboxItems(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const left = a.waitingSince ? new Date(a.waitingSince).getTime() : 0;
    const right = b.waitingSince ? new Date(b.waitingSince).getTime() : 0;
    return left - right;
  });
}
