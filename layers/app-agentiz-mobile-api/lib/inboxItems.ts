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
 * row carries the three things a decision needs — what kind of attention it is (`badge`, spelled by
 * `activityTypes.ts`, the same catalogue the notification policy is generated from), what is being
 * asked (`headline`) and the facts to decide on (`facts`) — plus the actions the client is allowed
 * to offer. Nothing here is the agent's prose: `facts` is files/branches/errors, never a summary.
 *
 * The entity ids stay on the row because the actions are the existing endpoints
 * (`/interactions/:id/answer`, `/proposals/:id/approve|reject`) — this is a projection for reading,
 * not a new write surface.
 */
export type InboxItemKind = 'question' | 'review' | 'push_failed' | 'reset_failed' | 'held_diff' | 'pr';

export type InboxActionKey = 'answer' | 'approve' | 'reject' | 'open_run' | 'open_url';

export interface InboxAction {
  key: InboxActionKey;
  label: string;
  style: 'primary' | 'default' | 'danger';
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
 * Who blocks whom, in that order: a question holds an agent mid-turn, a failed push or reset holds
 * a worker's directory, a review holds only the change itself, and a pull request holds nothing of
 * ours at all. Time is the tiebreaker inside a group, oldest first — the opposite of the feed,
 * because here the oldest row is the one that has been ignored longest.
 */
const PRIORITY: Record<InboxItemKind, number> = {
  question: 0,
  push_failed: 1,
  reset_failed: 1,
  review: 2,
  held_diff: 3,
  pr: 4,
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
  const kind: InboxItemKind = proposal.status === 'push_failed' ? 'push_failed'
    : proposal.status === 'reset_failed' ? 'reset_failed'
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
  const actions: InboxAction[] = [];
  if (kind !== 'reset_failed' && context.approvable !== false) {
    actions.push({ key: 'approve', label: kind === 'push_failed' ? 'Повторить push…' : 'Одобрить…', style: 'primary' });
  }
  actions.push({
    key: 'reject',
    label: kind === 'reset_failed' ? 'Повторить сброс…' : 'Отклонить…',
    style: kind === 'reset_failed' ? 'default' : 'danger',
  });
  return {
    ...base(kind, activityType, context),
    id: `proposal:${proposal.id}`,
    // A failure explains itself; a review is named by what it would commit.
    headline: kind === 'review'
      ? firstLine(proposal.commitMessage) ?? 'Изменения ждут ревью'
      : error ?? (kind === 'push_failed' ? 'Push не прошёл' : 'Сброс воркспейса не прошёл'),
    facts,
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
    projectId: run.projectId,
    taskId: run.taskId,
    runId: run.id,
    waitingSince: run.finishedAt ?? run.createdAt ?? null,
    // Applying a held diff is a panel action — this layer exposes no endpoint for it, so the card
    // is a link rather than a lie about what the phone can do.
    actions: [{ key: 'open_run', label: 'Открыть запуск', style: 'default' }],
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
    projectId: input.projectId,
    runId: input.runId,
    url: input.url,
    waitingSince: input.createdAt,
    actions: input.url ? [{ key: 'open_url', label: 'Открыть PR', style: 'default' }] : [],
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
