import { Op } from 'sequelize';
import { AgentActivity } from '../../models/AgentActivity';
import { AgentApprovalRequest } from '../../models/AgentApprovalRequest';
import { AgentProject } from '../../models/AgentProject';
import { AgentRun } from '../../models/AgentRun';
import { AgentRunDiff } from '../../models/AgentRunDiff';
import { AgentRunInteraction } from '../../models/AgentRunInteraction';
import { AgentRunJob } from '../../models/AgentRunJob';
import { AgentStageExecution } from '../../models/AgentStageExecution';
import { AgentTask } from '../../models/AgentTask';
import { AgentWorker } from '../../models/AgentWorker';
import { AgentWorkerHarness } from '../../models/AgentWorkerHarness';
import { AgentWorkspaceProposal } from '../../models/AgentWorkspaceProposal';
import { AgentWorkspaceProposalService } from '../../services/AgentWorkspaceProposalService';
import { accessActorId, can, type AccessActor } from '../access/projectAccess';
import { MIXED_HARNESS_KEY } from '../harness';
import { harnessTitle } from '../harnessCatalog';
import {
  approvalItem,
  harnessAuthItem,
  heldDiffItem,
  proposalItem,
  pullRequestItem,
  questionItem,
  runFailureItem,
  sortInboxItems,
  type InboxItem,
} from './items';

/**
 * Everything waiting on a person, gathered from the **live** entities.
 *
 * This is the collecting half of the inbox; `items.ts` next to it is the half that turns an entity
 * into a row a person can read. Both used to live in the mobile layer, because the phone was the
 * only reader. The panel is now the second one, and two readers computing "что меня ждёт" from
 * two pieces of code is how a screen and a badge start disagreeing about the same four rows.
 *
 * Two things are deliberately **not** here:
 *
 * * **Scope.** Which projects count is an argument (`projectIds`), never a branch inside. The
 *   phone passes `projectIdsForUser(userId, read)` through its own `mobileScope`, the panel passes
 *   the same call with the panel actor. One rule, two callers — and no `if (isMobile)` anywhere.
 * * **Dismissals.** «Скрыл напоминание» is `MobileInboxDismissal`, a model of the mobile layer,
 *   and the gesture only makes sense where there is a swipe to hang it on. So these functions
 *   answer the full list and the mobile service filters it; moving the model here to save that one
 *   call would be a migration.
 *
 * Everything is read fresh on every call and nothing comes from the `AgentActivity` journal (the
 * one exception, `pr.opened`, has no live entity of its own and says so at its use). The journal
 * only grows, so an answered question would never leave it.
 */

/** Proposal statuses a human has to act on — the same three the review screen shows buttons for. */
export const ACTIONABLE_PROPOSAL_STATUSES = ['waiting_review', 'push_failed', 'reset_failed'] as const;

/** Who is reading, and what they may look at. Empty `projectIds` means "nothing", never "all". */
export interface InboxScope {
  projectIds: string[];
  /**
   * The reader. Used for one thing only: an approval is addressed by token (and sometimes by
   * person), so whether a row is even shown depends on who is asking.
   *
   * An `AccessActor`, so the panel can pass the loaded user it already has and keep the
   * administrator flag and the bypass token that go with it; the phone passes a bare id, which is
   * the same type and deliberately carries neither.
   */
  actor: AccessActor;
}

/** The rows, plus the raw entities the mobile API's older arrays are built from. */
export interface CollectedInbox {
  items: InboxItem[];
  interactions: AgentRunInteraction[];
  proposals: AgentWorkspaceProposal[];
  heldDiffs: Array<{ diff: AgentRunDiff; run: AgentRun }>;
  /** Loaded on the way; handed back so a caller does not query the same tasks a second time. */
  taskById: Map<string, AgentTask>;
  runById: Map<string, AgentRun>;
}

/**
 * The newest run of each of the given tasks, in one query.
 *
 * Sorted client-side rather than with a window function: sqlite and postgres are both supported
 * deployments here, and the caller's list is bounded (the failed tasks of one owner).
 */
async function latestRunPerTask(taskIds: string[]): Promise<Map<string, AgentRun>> {
  if (taskIds.length === 0) return new Map();
  const runs = await AgentRun.findAll({
    where: { taskId: { [Op.in]: taskIds } },
    order: [['createdAt', 'DESC']],
  });
  const byTask = new Map<string, AgentRun>();
  for (const run of runs) if (!byTask.has(run.taskId)) byTask.set(run.taskId, run);
  return byTask;
}

/**
 * PR rows that still deserve a person's attention.
 *
 * A pull request is the one actionable event whose resolution happens outside Agentiz — nothing
 * here learns that it was merged. Its stand-in is the task: closing the task is what a person
 * does after the PR is dealt with, so an `open` task with an opened PR keeps the row and a
 * done/cancelled/ignored one drops it. A task that never gets closed keeps a visible PR, which is
 * the honest reading of "никто на него не посмотрел".
 */
function openPullRequests(rows: AgentActivity[], taskById: Map<string, AgentTask>): AgentActivity[] {
  const closed = new Set(['done', 'cancelled', 'ignored']);
  const seenRuns = new Set<string>();
  return rows.filter((row) => {
    const task = row.taskId ? taskById.get(row.taskId) : null;
    if (!task || closed.has(task.status)) return false;
    // One row per run: a re-opened PR for the same run is the same thing to look at.
    const key = row.runId ?? row.id;
    if (seenRuns.has(key)) return false;
    seenRuns.add(key);
    return true;
  });
}

/**
 * Of the given pending approvals, the ones **this** caller may actually decide.
 *
 * Filtered per row and not by the project query, because the addressee is a property of the
 * request (`assigneeToken`, plus an optional `assigneeUserId` naming one person). Showing a row
 * somebody cannot act on is worse here than anywhere else in the inbox: it is blocking, so it
 * would be counted in `actionableCount` and would never go away for that reader.
 */
export async function decidableApprovals(
  approvals: AgentApprovalRequest[],
  actor: AccessActor,
): Promise<AgentApprovalRequest[]> {
  const readerId = accessActorId(actor);
  const decisions = await Promise.all(approvals.map(async (approval) => {
    if (approval.assigneeUserId !== null && Number(approval.assigneeUserId) !== readerId) return false;
    return can(actor, approval.projectId, approval.assigneeToken);
  }));
  return approvals.filter((_approval, index) => decisions[index]);
}

/**
 * The two states of a worker that a person has to do something about, counted for the ambient
 * badge. Both are limited to `active` machines: a paused or revoked one being silent is the
 * operator's own decision, not a fault.
 *
 * `needLogin` — a harness on that machine cannot authenticate at all (`HarnessAuthState`), which
 * closes its claim gate until somebody opens a browser there. `offline` — a machine that is
 * supposed to be polling and has stopped, which is the other way work quietly stops moving.
 *
 * Deliberately **not** project-scoped, like the rest of the capacity surface: a worker belongs to
 * the installation, holds nothing secret (a name and a state, never a credential), and a machine
 * that cannot log in stops everybody's work, not one project's.
 */
export async function workerAlerts(): Promise<{ needLogin: number; offline: number }> {
  const workers = await AgentWorker.findAll({ where: { status: 'active' } });
  if (workers.length === 0) return { needLogin: 0, offline: 0 };
  const needLogin = await AgentWorkerHarness.count({
    where: { authState: 'expired', workerId: { [Op.in]: workers.map((worker) => worker.id) } },
  });
  return {
    needLogin,
    offline: workers.filter((worker) => worker.contactState() === 'offline').length,
  };
}

/**
 * Runs that are parked because the machine they need is logged out of its harness.
 *
 * Read from the **live** binding, never from the journal, like every other row here: the run
 * carries `waitingReason: 'harness_auth'` (written by the capacity sweep or by the stage that
 * failed on the credential), and the row only survives while a binding is still `expired`. That
 * is what closes it — the worker's first healthy report clears the binding and the row is gone
 * on the next refresh, with nobody having pressed anything.
 *
 * Matching a run to a machine goes through its job: a pinned job names the worker outright, and
 * an unpinned one is only here because no worker could log in at all, so any expired binding for
 * that harness names the problem correctly.
 */
export async function authBlockedRuns(projectIds: string[]): Promise<Array<{
  run: AgentRun;
  info: { harnessKey: string; harnessTitle: string; workerName: string; since: Date | null; detail: string | null };
}>> {
  const expired = await AgentWorkerHarness.findAll({ where: { authState: 'expired' } });
  if (expired.length === 0) return [];
  const runs = await AgentRun.findAll({
    where: {
      projectId: { [Op.in]: projectIds },
      waitingReason: 'harness_auth',
      status: { [Op.notIn]: ['succeeded', 'failed', 'cancelled'] },
    },
    order: [['updatedAt', 'DESC']],
    limit: 100,
  });
  if (runs.length === 0) return [];

  const jobs = await AgentRunJob.findAll({ where: { runId: { [Op.in]: runs.map((run) => run.id) } } });
  const jobByRun = new Map(jobs.map((job) => [job.runId, job]));
  const workers = await AgentWorker.findAll({
    where: { id: { [Op.in]: [...new Set(expired.map((binding) => binding.workerId))] } },
  });
  const workerById = new Map(workers.map((worker) => [worker.id, worker]));

  return runs.flatMap((run) => {
    const job = jobByRun.get(run.id) ?? null;
    const binding = expired.find((item) => (job?.requiredWorkerId ? item.workerId === job.requiredWorkerId : true)
      && (!job?.harnessKey || job.harnessKey === MIXED_HARNESS_KEY || item.harnessKey === job.harnessKey));
    // Nothing expired matches this run any more — its binding recovered while the run kept a
    // stale `waitingReason` (that is cleared when the run actually restarts). Nothing is
    // blocked, so nothing is shown, and the row closes itself with nobody pressing anything.
    if (!binding) return [];
    return [{
      run,
      info: {
        harnessKey: binding.harnessKey,
        harnessTitle: harnessTitle(binding.harnessKey),
        workerName: workerById.get(binding.workerId)?.name ?? binding.workerId,
        since: binding.authFailedSince ?? null,
        detail: binding.authDetail ?? null,
      },
    }];
  });
}

/** Diffs `requireApproval` parked in Agentiz: stored, never applied, from a succeeded repository run. */
export async function heldDiffs(projectIds: string[]): Promise<Array<{ diff: AgentRunDiff; run: AgentRun }>> {
  const diffs = await AgentRunDiff.findAll({
    where: { projectId: { [Op.in]: projectIds }, appliedAt: null, proposalId: null },
    order: [['createdAt', 'DESC']],
    limit: 200,
  });
  if (diffs.length === 0) return [];
  const runs = await AgentRun.findAll({ where: { id: { [Op.in]: diffs.map((diff) => diff.runId) } } });
  const runById = new Map(runs.map((run) => [run.id, run]));
  return diffs.flatMap((diff) => {
    const run = runById.get(diff.runId);
    if (!run || run.status !== 'succeeded') return [];
    const action = run.pipelineSnapshot?.finalAction;
    if (action?.requireApproval !== true) return [];
    return [{ diff, run }];
  });
}

/**
 * Everything waiting on the caller *right now*, across their projects: pending questions,
 * proposals somebody has to approve/reject/retry, approvals addressed to them, repository runs
 * whose diff `requireApproval` holds back, tasks stuck on a failure, and opened pull requests.
 *
 * Sorted, but **not** filtered by dismissals — see the note at the top of this file.
 */
export async function collectInboxItems(scope: InboxScope): Promise<CollectedInbox> {
  const { projectIds, actor } = scope;
  if (projectIds.length === 0) {
    return { items: [], interactions: [], proposals: [], heldDiffs: [], taskById: new Map(), runById: new Map() };
  }

  const [interactions, proposals, approvals, held, openedPrs, failedTasks] = await Promise.all([
    AgentRunInteraction.findAll({
      where: { projectId: { [Op.in]: projectIds }, status: 'pending' },
      order: [['createdAt', 'ASC']],
      limit: 200,
    }),
    AgentWorkspaceProposal.findAll({
      where: { projectId: { [Op.in]: projectIds }, status: { [Op.in]: [...ACTIONABLE_PROPOSAL_STATUSES] } },
      order: [['updatedAt', 'DESC']],
      limit: 200,
    }),
    // Approvals are the one row here whose visibility is not the caller's read scope: a decision
    // belongs to whoever may make it. Filtered by the request's own token below rather than by a
    // narrower project query, because a graph may address one to a token of its choosing.
    AgentApprovalRequest.findAll({
      where: { projectId: { [Op.in]: projectIds }, status: 'pending' },
      order: [['createdAt', 'ASC']],
      limit: 200,
    }),
    heldDiffs(projectIds),
    // `pr.opened` is `action_required` in the catalogue but has no live entity of its own — see
    // openPullRequests for what makes one of these go away.
    AgentActivity.findAll({
      where: { projectId: { [Op.in]: projectIds }, type: 'pr.opened' },
      order: [['createdAt', 'DESC']],
      limit: 100,
    }),
    // A failed run leaves its task in `failed` and a re-run moves it out again (queued →
    // running), so this status *is* "последняя попытка упала и с тех пор никто ничего не сделал"
    // — one row per stuck task instead of one per failed attempt, without ranking runs here.
    AgentTask.findAll({
      where: { projectId: { [Op.in]: projectIds }, status: 'failed' },
      order: [['updatedAt', 'DESC']],
      limit: 100,
    }),
  ]);

  const failedRuns = await latestRunPerTask(failedTasks.map((task) => task.id));
  const authBlocked = await authBlockedRuns(projectIds);

  const runIds = new Set<string>([
    ...authBlocked.map((item) => item.run.id),
    ...interactions.map((item) => item.runId),
    ...proposals.map((item) => item.latestRunId),
    ...approvals.map((item) => item.runId).filter(Boolean) as string[],
    ...held.map((item) => item.diff.runId),
    ...openedPrs.map((row) => row.runId).filter(Boolean) as string[],
  ]);
  const [runs, projects, stages, diffs] = await Promise.all([
    AgentRun.findAll({ where: { id: { [Op.in]: [...runIds] } } }),
    AgentProject.findAll({ where: { id: { [Op.in]: projectIds } } }),
    // Only to name the stage a question came from: "этап implement" is what tells a reader which
    // half of the pipeline is parked.
    AgentStageExecution.findAll({
      where: { id: { [Op.in]: [...new Set(interactions.map((item) => item.stageExecutionId).filter(Boolean))] as string[] } },
    }),
    AgentRunDiff.findAll({
      where: { id: { [Op.in]: [...new Set(proposals.map((item) => item.latestDiffId).filter(Boolean))] as string[] } },
    }),
  ]);
  const runById = new Map(runs.map((run) => [run.id, run]));
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const diffById = new Map(diffs.map((diff) => [diff.id, diff]));

  const taskIds = new Set<string>([
    ...authBlocked.map((item) => item.run.taskId),
    ...proposals.map((item) => item.taskId),
    ...approvals.map((item) => item.taskId).filter(Boolean) as string[],
    ...[...runById.values()].map((run) => run.taskId),
    ...openedPrs.map((row) => row.taskId).filter(Boolean) as string[],
  ]);
  const tasks = await AgentTask.findAll({ where: { id: { [Op.in]: [...taskIds] } } });
  const taskById = new Map([...tasks, ...failedTasks].map((task) => [task.id, task]));
  // The pipeline goes into the context for one reason: the notification policy resolves
  // `pipelines[specId]` before the project scope, so a row that skipped it could tell a reader
  // "пуш включён" about an event their pipeline rule had switched off.
  const contextOf = (projectId: string, taskId: string | null | undefined, pipelineSpecId?: string | null) => ({
    project: projectById.get(projectId) ?? null,
    task: taskId ? taskById.get(taskId) ?? null : null,
    pipelineSpecId: pipelineSpecId ?? null,
  });

  const items = sortInboxItems([
    // First in the list and first here: while a machine is logged out, nothing of that harness
    // runs on it, so every other row is downstream of this one.
    ...authBlocked.map(({ run, info }) => harnessAuthItem(run, info,
      contextOf(run.projectId, run.taskId, run.pipelineSpecId))),
    ...interactions.map((item) => questionItem(item, {
      ...contextOf(item.projectId, runById.get(item.runId)?.taskId, runById.get(item.runId)?.pipelineSpecId),
      run: runById.get(item.runId) ?? null,
      stageRole: item.stageExecutionId ? stageById.get(item.stageExecutionId)?.role ?? null : null,
    })),
    ...proposals.map((item) => {
      const diff = item.latestDiffId ? diffById.get(item.latestDiffId) ?? null : null;
      return proposalItem(item, {
        ...contextOf(item.projectId, item.taskId, runById.get(item.latestRunId)?.pipelineSpecId),
        diff,
        approvable: AgentWorkspaceProposalService.isApprovableDiff(diff),
      });
    }),
    ...(await decidableApprovals(approvals, actor)).map((item) => {
      const run = item.runId ? runById.get(item.runId) ?? null : null;
      return approvalItem(item, {
        ...contextOf(item.projectId, item.taskId, run?.pipelineSpecId),
        verdict: run?.verdict ?? null,
        verdictReason: run?.verdictReason ?? null,
        branch: run?.branch ?? null,
      });
    }),
    ...held.map(({ diff, run }) => heldDiffItem(diff, run, contextOf(run.projectId, run.taskId, run.pipelineSpecId))),
    // A stuck task is only actionable while its proposal is not: an unapprovable proposal on the
    // same run already says "освободите папку", and two rows for one dead end read as two.
    ...failedTasks.flatMap((task) => {
      const run = failedRuns.get(task.id);
      if (!run || proposals.some((proposal) => proposal.taskId === task.id)) return [];
      return [runFailureItem(run, contextOf(task.projectId, task.id, run.pipelineSpecId))];
    }),
    ...openPullRequests(openedPrs, taskById).map((row) => pullRequestItem({
      id: row.id,
      projectId: row.projectId,
      url: typeof (row.data as any)?.prUrl === 'string' ? (row.data as any).prUrl : row.body,
      createdAt: row.createdAt,
      runId: row.runId,
    }, contextOf(row.projectId, row.taskId, row.runId ? runById.get(row.runId)?.pipelineSpecId : null))),
  ]);

  return { items, interactions, proposals, heldDiffs: held, taskById, runById };
}

/**
 * Everything waiting on a person because of **one run** — what a run screen puts above its own
 * result, so that a run somebody opened from a notification states what to do about itself
 * instead of leaving the reader to work it out from a status word and a log.
 *
 * Same projection as the inbox, narrowed to this run: its pending questions, the proposal it
 * produced, a diff `requireApproval` held back, and the run's own failure when nothing else has
 * happened on the task since.
 */
export async function collectRunInboxItems(
  run: AgentRun,
  task: AgentTask | null,
  project: AgentProject | null,
): Promise<InboxItem[]> {
  const [interactions, proposal, held, authBlocked] = await Promise.all([
    AgentRunInteraction.findAll({ where: { runId: run.id, status: 'pending' }, order: [['createdAt', 'ASC']] }),
    AgentWorkspaceProposal.findOne({
      where: { latestRunId: run.id, status: { [Op.in]: [...ACTIONABLE_PROPOSAL_STATUSES] } },
    }),
    heldDiffs([run.projectId]),
    authBlockedRuns([run.projectId]),
  ]);
  const [stages, diff] = await Promise.all([
    AgentStageExecution.findAll({
      where: { id: { [Op.in]: [...new Set(interactions.map((item) => item.stageExecutionId).filter(Boolean))] as string[] } },
    }),
    proposal?.latestDiffId ? AgentRunDiff.findByPk(proposal.latestDiffId) : Promise.resolve(null),
  ]);
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const context = { task: task ?? null, project, pipelineSpecId: run.pipelineSpecId ?? null };

  // "Открыть запуск" is the reader's current location here, so it is dropped rather than drawn as
  // a button that does nothing. Everything else is the same projection the inbox renders.
  const here = (items: InboxItem[]) => items.map((item) => ({
    ...item,
    actions: item.actions.filter((action) => action.key !== 'open_run'),
  }));

  return here(sortInboxItems([
    // The run screen is exactly where "он просто стоит и ничего не пишет" is read, so the
    // reason it stands is the first thing on it.
    ...authBlocked.filter((entry) => entry.run.id === run.id)
      .map((entry) => harnessAuthItem(entry.run, entry.info, context)),
    ...interactions.map((item) => questionItem(item, {
      ...context,
      run,
      stageRole: item.stageExecutionId ? stageById.get(item.stageExecutionId)?.role ?? null : null,
    })),
    ...(proposal
      ? [proposalItem(proposal, {
          ...context,
          diff,
          approvable: AgentWorkspaceProposalService.isApprovableDiff(diff),
        })]
      : []),
    ...held.filter((entry) => entry.diff.runId === run.id).map((entry) => heldDiffItem(entry.diff, entry.run, context)),
    // Only when the task is still sitting on this failure: a task re-run since then is out of
    // `failed`, and offering "запустить ещё раз" on an old attempt would compete with it.
    ...(!proposal && run.status === 'failed' && task?.status === 'failed' ? [runFailureItem(run, context)] : []),
  ]));
}

/**
 * Everything waiting on a person within one task — the "что дальше" strip on a task screen.
 *
 * `actor` is optional and means exactly one thing: without it the approvals are left out, because
 * an approval is addressed to somebody and there is nobody to address it to. That is the
 * pre-existing behaviour of the mobile call and not a shortcut.
 */
export async function collectTaskInboxItems(
  task: AgentTask,
  project: AgentProject | null,
  actor?: AccessActor,
): Promise<InboxItem[]> {
  const [interactions, proposals, approvals, runs, authBlocked] = await Promise.all([
    AgentRunInteraction.findAll({ where: { projectId: task.projectId, status: 'pending' }, order: [['createdAt', 'ASC']] }),
    AgentWorkspaceProposal.findAll({
      where: { taskId: task.id, status: { [Op.in]: [...ACTIONABLE_PROPOSAL_STATUSES] } },
      order: [['updatedAt', 'DESC']],
    }),
    AgentApprovalRequest.findAll({ where: { taskId: task.id, status: 'pending' }, order: [['createdAt', 'ASC']] }),
    AgentRun.findAll({ where: { taskId: task.id }, attributes: ['id', 'pipelineSpecId', 'verdict', 'verdictReason'] }),
    authBlockedRuns([task.projectId]),
  ]);
  const runById = new Map(runs.map((run) => [run.id, run]));
  const runIds = new Set(runs.map((run) => run.id));
  const pipelineOfRun = new Map(runs.map((run) => [run.id, run.pipelineSpecId ?? null]));
  const ownInteractions = interactions.filter((item) => runIds.has(item.runId));

  const [stages, diffs, held] = await Promise.all([
    AgentStageExecution.findAll({
      where: { id: { [Op.in]: [...new Set(ownInteractions.map((item) => item.stageExecutionId).filter(Boolean))] as string[] } },
    }),
    AgentRunDiff.findAll({
      where: { id: { [Op.in]: [...new Set(proposals.map((item) => item.latestDiffId).filter(Boolean))] as string[] } },
    }),
    heldDiffs([task.projectId]),
  ]);
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const diffById = new Map(diffs.map((diff) => [diff.id, diff]));
  // One task can hold rows from runs of different pipelines, so the policy scope is per row.
  const context = (pipelineSpecId?: string | null) => ({ task, project, pipelineSpecId: pipelineSpecId ?? null });

  const latestRun = task.status === 'failed' && proposals.length === 0
    ? (await latestRunPerTask([task.id])).get(task.id) ?? null
    : null;

  return sortInboxItems([
    // Same reason as on the run screen: this strip is what a person reads after launching from
    // the phone, and a queue that is not moving has to say so here rather than nowhere.
    ...authBlocked.filter((entry) => entry.run.taskId === task.id)
      .map((entry) => harnessAuthItem(entry.run, entry.info, context(entry.run.pipelineSpecId))),
    ...ownInteractions.map((item) => questionItem(item, {
      ...context(pipelineOfRun.get(item.runId)),
      stageRole: item.stageExecutionId ? stageById.get(item.stageExecutionId)?.role ?? null : null,
    })),
    ...(latestRun ? [runFailureItem(latestRun, context(latestRun.pipelineSpecId))] : []),
    ...proposals.map((item) => {
      const diff = item.latestDiffId ? diffById.get(item.latestDiffId) ?? null : null;
      return proposalItem(item, {
        ...context(pipelineOfRun.get(item.latestRunId)),
        diff,
        approvable: AgentWorkspaceProposalService.isApprovableDiff(diff),
      });
    }),
    ...(actor === undefined ? [] : (await decidableApprovals(approvals, actor)).map((item) => {
      const run = item.runId ? runById.get(item.runId) ?? null : null;
      return approvalItem(item, {
        ...context(run?.pipelineSpecId),
        verdict: run?.verdict ?? null,
        verdictReason: run?.verdictReason ?? null,
        branch: run?.branch ?? null,
      });
    })),
    ...held.filter(({ run }) => run.taskId === task.id)
      .map(({ diff, run }) => heldDiffItem(diff, run, context(run.pipelineSpecId))),
  ]);
}
