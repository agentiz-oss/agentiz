import type { AdminizerRouteMiddleware } from '@nodeknit/app-adminizer';
import { Op } from 'sequelize';
import { AgentRun } from '../models/AgentRun';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentWorker } from '../models/AgentWorker';
import { AgentStageExecution } from '../models/AgentStageExecution';
import { AgentRunLog } from '../models/AgentRunLog';
import { AgentRunDiff } from '../models/AgentRunDiff';
import { AgentRunInteraction } from '../models/AgentRunInteraction';
import { AgentProject } from '../models/AgentProject';
import { AgentTask } from '../models/AgentTask';
import { AgentPipelineService } from '../services/AgentPipelineService';
import { AgentRunInteractionService, InteractionError, type InteractionActor } from '../services/AgentRunInteractionService';
import { AgentWorkspaceProposalService, WorkspaceProposalError } from '../services/AgentWorkspaceProposalService';
import { adminizerModuleUrl } from './adminizerModuleUrl';
import { listRunLogs, type RunLogPage } from './runLogs';
import { runUsage } from './runUsage';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function positive(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

/** The wire shape of one log page: the rows plus everything needed to ask for the next one. */
function logPayload(page: RunLogPage) {
  return {
    logs: page.logs.map((log) => log.toJSON()),
    logsCursor: page.nextCursor,
    logsEarlierCursor: page.earlierCursor,
    logsHasEarlier: page.hasEarlier,
    logsHasMore: page.hasMore,
  };
}

function actorOf(req: any): InteractionActor {
  const user = req.session?.UserAP ?? req.user ?? null;
  const groups = user?.groups ?? user?.GroupAPs ?? [];
  return {
    id: typeof user?.id === 'number' ? user.id : null,
    name: user?.login ?? user?.fullName ?? 'admin',
    isAdmin: Boolean(user?.isAdmin || (Array.isArray(groups) && groups.some((group: any) => group?.name === 'admin'))),
  };
}

function routeError(res: any, error: unknown) {
  if (error instanceof InteractionError) return res.status(error.status).json({ message: error.message });
  if (error instanceof WorkspaceProposalError) return res.status(error.statusCode).json({ message: error.message });
  return res.status(400).json({ message: error instanceof Error ? error.message : String(error) });
}

/** A run is "in flight" while it is in one of these states — the board's top section. */
const ACTIVE_RUN_STATUSES = ['pending', 'running', 'waiting_input'];

/**
 * The run board: everything currently in flight plus the last finished runs, in one payload.
 * Each row carries what makes a running agent legible without opening it — its stages, the worker
 * that claimed the job, the newest log line and whether it is blocked on a question.
 */
async function listRuns(projectId: string) {
  const scope = projectId ? { projectId } : {};
  const [active, recent] = await Promise.all([
    AgentRun.findAll({ where: { ...scope, status: { [Op.in]: ACTIVE_RUN_STATUSES } }, order: [['createdAt', 'DESC']], limit: 100 }),
    AgentRun.findAll({ where: { ...scope, status: { [Op.notIn]: ACTIVE_RUN_STATUSES } }, order: [['createdAt', 'DESC']], limit: 25 }),
  ]);
  const runs = [...active, ...recent];
  if (runs.length === 0) return { active: [], recent: [] };

  const runIds = runs.map((run) => run.id);
  const activeIds = active.map((run) => run.id);
  const [stages, tasks, projects, jobs, interactions, logs] = await Promise.all([
    AgentStageExecution.findAll({ where: { runId: runIds }, order: [['stageIndex', 'ASC']] }),
    AgentTask.findAll({ where: { id: [...new Set(runs.map((run) => run.taskId))] } }),
    AgentProject.findAll({ where: { id: [...new Set(runs.map((run) => run.projectId))] } }),
    AgentRunJob.findAll({ where: { runId: runIds }, order: [['createdAt', 'ASC']] }),
    AgentRunInteraction.findAll({ where: { runId: runIds, status: 'pending' } }),
    // Only the live runs get a "last line" — for a finished run the result summary says more, and
    // the log table is the biggest one here.
    activeIds.length > 0
      ? AgentRunLog.findAll({ where: { runId: activeIds }, order: [['createdAt', 'DESC']], limit: 500 })
      : Promise.resolve([]),
  ]);
  const workerIds = [...new Set(jobs.map((job) => job.workerId).filter((id): id is string => Boolean(id)))];
  const workers = workerIds.length > 0 ? await AgentWorker.findAll({ where: { id: workerIds } }) : [];

  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const projectMap = new Map(projects.map((project) => [project.id, project]));
  const workerMap = new Map(workers.map((worker) => [worker.id, worker]));
  const stagesByRun = new Map<string, AgentStageExecution[]>();
  for (const stage of stages) {
    const list = stagesByRun.get(stage.runId) ?? [];
    list.push(stage);
    stagesByRun.set(stage.runId, list);
  }
  const jobByRun = new Map(jobs.map((job) => [job.runId, job]));
  const pendingByRun = new Map<string, number>();
  for (const interaction of interactions) {
    pendingByRun.set(interaction.runId, (pendingByRun.get(interaction.runId) ?? 0) + 1);
  }
  // Logs arrive newest first, so the first row seen for a run is its latest line.
  const lastLogByRun = new Map<string, AgentRunLog>();
  for (const log of logs) {
    if (!lastLogByRun.has(log.runId)) lastLogByRun.set(log.runId, log);
  }

  const toCard = (run: AgentRun) => {
    const job = jobByRun.get(run.id);
    const lastLog = lastLogByRun.get(run.id);
    return {
      usage: runUsage(run),
      id: run.id,
      status: run.status,
      trigger: run.trigger,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      currentStageIndex: run.currentStageIndex,
      errorMessage: run.errorMessage,
      resultSummary: run.resultSummary,
      task: taskMap.get(run.taskId) ? { id: run.taskId, title: taskMap.get(run.taskId)!.title } : null,
      project: projectMap.get(run.projectId) ? { id: run.projectId, name: projectMap.get(run.projectId)!.name } : null,
      stages: (stagesByRun.get(run.id) ?? []).map((stage) => ({
        stageIndex: stage.stageIndex,
        role: stage.role,
        status: stage.status,
      })),
      job: job
        ? {
            status: job.status,
            lastError: job.lastError,
            worker: job.workerId ? { id: job.workerId, name: workerMap.get(job.workerId)?.name ?? job.workerId } : null,
          }
        : null,
      pendingInteractions: pendingByRun.get(run.id) ?? 0,
      lastLog: lastLog ? { level: lastLog.level, message: lastLog.message, createdAt: lastLog.createdAt } : null,
    };
  };

  return { active: active.map(toCard), recent: recent.map(toCard) };
}

/**
 * One run in full: its stages, its logs and — when the pipeline changed code — the diff, with a
 * button to apply it. Its own page rather than an inline panel on the task screen, because a run
 * with a large patch and a full log needs the room.
 */
export const runRoutes: AdminizerRouteMiddleware[] = [
  {
    route: '/agentiz-runs',
    method: 'get',
    handler: async (req, res) => {
      try {
        const method = str(req.query._method);

        if (method === 'listRuns') {
          return res.json({ data: await listRuns(str(req.query.projectId)) });
        }

        // Just the log, for the run screen's polling tick and its "load earlier" button. The full
        // details payload carries the patch, which can be megabytes — refetching it every 2.5 s to
        // learn that three lines were added is what this exists to avoid.
        if (method === 'getRunLogs') {
          const runId = str(req.query.runId);
          if (!runId) return res.status(400).json({ message: 'runId is required' });
          return res.json({
            data: logPayload(await listRunLogs(runId, {
              after: str(req.query.after) || null,
              before: str(req.query.before) || null,
              limit: positive(req.query.limit, 500),
            })),
          });
        }

        if (method === 'getRunDetails') {
          const runId = str(req.query.runId);
          if (!runId) return res.status(400).json({ message: 'runId is required' });
          const run = await AgentRun.findByPk(runId);
          if (!run) return res.status(404).json({ message: 'Run not found' });
          const stages = await AgentStageExecution.findAll({
            where: { runId },
            order: [['stageIndex', 'ASC']],
          });
          // With `logsAfter` the payload carries only the lines added since — that is what the run
          // screen's 2.5 s tick sends, so a live run costs a few rows per poll instead of the
          // whole log every time.
          const logs = await listRunLogs(runId, {
            after: str(req.query.logsAfter) || null,
            limit: positive(req.query.logLimit, 500),
          });
          const diff = await AgentRunDiff.findOne({ where: { runId } });
          const interactions = await AgentRunInteraction.findAll({ where: { runId }, order: [['createdAt', 'ASC']] });
          const workspaceReview = await AgentWorkspaceProposalService.detailsForRun(run);
          const latestWorkspaceDiff = workspaceReview
            ? workspaceReview.revisions.find((revision) => revision.id === workspaceReview.proposal.latestDiffId) ?? null
            : null;
          return res.json({
            data: {
              run: run.toJSON(),
              usage: runUsage(run),
              stages: stages.map((stage) => stage.toJSON()),
              ...logPayload(logs),
              diff: diff?.toJSON() ?? null,
              interactions: interactions.map((interaction) => interaction.toJSON()),
              proposal: workspaceReview?.proposal.toJSON() ?? null,
              revisions: workspaceReview?.revisions.map((revision) => revision.toJSON()) ?? [],
              latestDiff: latestWorkspaceDiff?.toJSON() ?? null,
            },
          });
        }

        // Same URL serves both screens: one run when `runId` names it (every existing link does),
        // the board of everything running when it does not.
        return req.Inertia.render({
          component: 'module',
          props: {
            moduleComponent: adminizerModuleUrl(str(req.query.runId) ? 'AgentizRunDetail' : 'AgentizRuns'),
          },
        });
      } catch (error) {
        return routeError(res, error);
      }
    },
  },
  {
    route: '/agentiz-runs',
    method: 'post',
    handler: async (req, res) => {
      try {
        const method = str(req.body?._method);

        if (method === 'applyRunDiff') {
          const runId = str(req.body?.runId);
          if (!runId) return res.status(400).json({ message: 'runId is required' });
          const actor = (req as any).session?.UserAP?.login ?? (req as any).user?.login ?? 'admin';
          const diff = await AgentPipelineService.applyStoredDiff(runId, String(actor));
          return res.json({ data: diff.toJSON() });
        }

        if (method === 'cancelRun') {
          const runId = str(req.body?.runId);
          if (!runId) return res.status(400).json({ message: 'runId is required' });
          const run = await AgentPipelineService.cancelRun(runId);
          return res.json({ data: run.toJSON() });
        }

        if (method === 'approveWorkspaceProposal') {
          const proposal = await AgentWorkspaceProposalService.approve(
            str(req.body?.proposalId), Number(req.body?.revision), actorOf(req).name,
            { targetBranch: str(req.body?.targetBranch) || undefined, commitMessage: str(req.body?.commitMessage) || undefined },
          );
          return res.json({ data: proposal.toJSON() });
        }

        if (method === 'continueWorkspaceProposal') {
          const run = await AgentWorkspaceProposalService.continueWork(
            str(req.body?.proposalId), Number(req.body?.revision), actorOf(req), str(req.body?.comment),
          );
          return res.json({ data: run.toJSON() });
        }

        if (method === 'rejectWorkspaceProposal') {
          const proposal = await AgentWorkspaceProposalService.reject(
            str(req.body?.proposalId), Number(req.body?.revision), actorOf(req).name,
          );
          return res.json({ data: proposal.toJSON() });
        }

        // Deliberately takes no revision: this is the exit from the statuses where nobody is
        // reviewing anything, and refusing it over a stale revision would keep the directory locked
        // for the sake of an optimistic check on a decision that is not being made.
        if (method === 'releaseWorkspaceProposal') {
          const outcome = await AgentWorkspaceProposalService.release(
            str(req.body?.proposalId), actorOf(req).name,
            { force: req.body?.force === true || str(req.body?.force) === 'true' },
          );
          return res.json({
            data: outcome.proposal.toJSON(),
            released: outcome.released,
            queuedJobId: outcome.queuedJobId,
          });
        }

        if (method === 'answerInteraction') {
          const interactionId = str(req.body?.interactionId);
          if (!interactionId) return res.status(400).json({ message: 'interactionId is required' });
          const action = str(req.body?.action) as 'accept' | 'decline' | 'cancel';
          const content = req.body?.content && typeof req.body.content === 'object' && !Array.isArray(req.body.content)
            ? req.body.content as Record<string, unknown>
            : null;
          const interaction = await AgentRunInteractionService.answer(interactionId, action, content, actorOf(req));
          return res.json({ data: interaction.toJSON() });
        }

        return res.status(400).json({ message: `Unknown _method: ${method || '(none)'}` });
      } catch (error: any) {
        return routeError(res, error);
      }
    },
  },
  {
    route: '/agentiz-interactions',
    method: 'get',
    handler: async (req, res) => {
      try {
        if (str(req.query._method) === 'listPending') {
          const interactions = await AgentRunInteractionService.listPending(actorOf(req));
          const runIds = [...new Set(interactions.map((item) => item.runId))];
          const stageIds = [...new Set(interactions.map((item) => item.stageExecutionId))];
          const projectIds = [...new Set(interactions.map((item) => item.projectId))];
          const [runs, stages, projects] = await Promise.all([
            AgentRun.findAll({ where: { id: runIds } }),
            AgentStageExecution.findAll({ where: { id: stageIds } }),
            AgentProject.findAll({ where: { id: projectIds } }),
          ]);
          const tasks = await AgentTask.findAll({ where: { id: runs.map((run) => run.taskId) } });
          const runMap = new Map(runs.map((run) => [run.id, run]));
          const stageMap = new Map(stages.map((stage) => [stage.id, stage]));
          const taskMap = new Map(tasks.map((task) => [task.id, task]));
          const projectMap = new Map(projects.map((project) => [project.id, project]));
          return res.json({
            data: interactions.map((interaction) => {
              const run = runMap.get(interaction.runId);
              return {
                ...interaction.toJSON(),
                run: run ? { id: run.id, taskId: run.taskId } : null,
                stage: stageMap.get(interaction.stageExecutionId)?.toJSON() ?? null,
                task: run ? taskMap.get(run.taskId)?.toJSON() ?? null : null,
                project: projectMap.get(interaction.projectId)?.toJSON() ?? null,
              };
            }),
          });
        }
        return req.Inertia.render({
          component: 'module',
          props: { moduleComponent: adminizerModuleUrl('AgentizInteractions') },
        });
      } catch (error) {
        return routeError(res, error);
      }
    },
  },
  {
    route: '/agentiz-interactions',
    method: 'post',
    handler: async (req, res) => {
      try {
        if (str(req.body?._method) !== 'answerInteraction') {
          return res.status(400).json({ message: 'Unknown _method' });
        }
        const interactionId = str(req.body?.interactionId);
        const action = str(req.body?.action) as 'accept' | 'decline' | 'cancel';
        const content = req.body?.content && typeof req.body.content === 'object' && !Array.isArray(req.body.content)
          ? req.body.content as Record<string, unknown>
          : null;
        const interaction = await AgentRunInteractionService.answer(interactionId, action, content, actorOf(req));
        return res.json({ data: interaction.toJSON() });
      } catch (error) {
        return routeError(res, error);
      }
    },
  },
];
