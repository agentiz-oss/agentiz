import type { AdminizerRouteMiddleware } from '@nodeknit/app-adminizer';
import { AgentRun } from '../models/AgentRun';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentWorker } from '../models/AgentWorker';
import { AgentStageExecution } from '../models/AgentStageExecution';
import { AgentRunDiff } from '../models/AgentRunDiff';
import { AgentRunInteraction } from '../models/AgentRunInteraction';
import { AgentProject } from '../models/AgentProject';
import { AgentTask } from '../models/AgentTask';
import { PipelineSpec } from '../models/PipelineSpec';
import { AgentPipelineService } from '../services/AgentPipelineService';
import { AgentRunInteractionService, InteractionError, type InteractionActor } from '../services/AgentRunInteractionService';
import { AgentWorkspaceProposalService, WorkspaceProposalError } from '../services/AgentWorkspaceProposalService';
import { listRuns } from './runBoard';
import { listRunLogs, type RunLogPage } from './runLogs';
import { runUsage } from './runUsage';
import { guardProject, panelActor, requirePanelUser, requestAccessCache } from './access/panelGuard';
import { projectIdsForUser } from './access/projectAccess';
import { PROJECT_TOKENS } from './access/tokens';
import { AgentWorkspaceProposal } from '../models/AgentWorkspaceProposal';
import { legacyRedirect } from './panel/legacyRedirect';

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

/**
 * Resolves a run and the right to touch it. `adminizerMiddlewares` are mounted before Adminizer's
 * policies, so these two calls are the whole check this route gets; the id is turned into a
 * project and the token is checked there. A run of a project the caller cannot see answers 404 —
 * the same answer a run that never existed gets.
 */
async function guardRun(req: any, res: any, runId: string, token: string): Promise<AgentRun | null> {
  const run = await AgentRun.findByPk(runId);
  if (!run) {
    res.status(404).json({ message: 'Run not found' });
    return null;
  }
  return (await guardProject(req, res, run.projectId, token)) ? run : null;
}

/** The same, for the four decisions taken on a workspace proposal. */
async function guardProposal(req: any, res: any, proposalId: string, token: string): Promise<boolean> {
  const proposal = proposalId ? await AgentWorkspaceProposal.findByPk(proposalId) : null;
  if (!proposal) {
    res.status(404).json({ message: 'Proposal not found' });
    return false;
  }
  return guardProject(req, res, proposal.projectId, token);
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
        if (!requirePanelUser(req, res)) return undefined;

        if (method === 'listRuns') {
          const requested = str(req.query.projectId);
          if (requested && !await guardProject(req, res, requested, PROJECT_TOKENS.read)) return undefined;
          return res.json({
            data: await listRuns(
              requested,
              requested ? undefined : await projectIdsForUser(panelActor(req), PROJECT_TOKENS.read, requestAccessCache(req)),
              str(req.query.status) || undefined,
            ),
          });
        }

        // Just the log, for the run screen's polling tick and its "load earlier" button. The full
        // details payload carries the patch, which can be megabytes — refetching it every 2.5 s to
        // learn that three lines were added is what this exists to avoid.
        if (method === 'getRunLogs') {
          const runId = str(req.query.runId);
          if (!runId) return res.status(400).json({ message: 'runId is required' });
          if (!await guardRun(req, res, runId, PROJECT_TOKENS.read)) return undefined;
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
          const run = await guardRun(req, res, runId, PROJECT_TOKENS.read);
          if (!run) return undefined;
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
          // Three names the screen would otherwise print as ids: the task the run belongs to, the
          // machine that claimed it and the spec it came from. The newest job is the one that
          // matters — a `worker_workspace` run gets a second one for the delivery.
          const [task, job, spec] = await Promise.all([
            AgentTask.findByPk(run.taskId, { attributes: ['id', 'title', 'status'] }),
            AgentRunJob.findOne({ where: { runId }, order: [['createdAt', 'DESC']] }),
            run.pipelineSpecId
              ? PipelineSpec.findByPk(run.pipelineSpecId, { attributes: ['id', 'name'] })
              : Promise.resolve(null),
          ]);
          const worker = job?.workerId ? await AgentWorker.findByPk(job.workerId, { attributes: ['id', 'name'] }) : null;
          const workspaceReview = await AgentWorkspaceProposalService.detailsForRun(run);
          const latestWorkspaceDiff = workspaceReview
            ? workspaceReview.revisions.find((revision) => revision.id === workspaceReview.proposal.latestDiffId) ?? null
            : null;
          return res.json({
            data: {
              run: run.toJSON(),
              usage: runUsage(run),
              task: task ? { id: task.id, title: task.title, status: task.status } : null,
              pipeline: spec ? { id: spec.id, name: spec.name } : null,
              job: job
                ? {
                    id: job.id,
                    status: job.status,
                    jobKind: job.jobKind,
                    lastError: job.lastError,
                    harnessKey: job.harnessKey,
                    worker: worker ? { id: worker.id, name: worker.name } : job.workerId ? { id: job.workerId, name: job.workerId } : null,
                  }
                : null,
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

        // Nothing renders here any more: this address is one run when `runId` names it (every
        // existing link does) and the board when it does not, and both of those moved.
        return legacyRedirect(req, res, 'runs');
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
        if (!requirePanelUser(req, res)) return undefined;

        if (method === 'applyRunDiff') {
          const runId = str(req.body?.runId);
          if (!runId) return res.status(400).json({ message: 'runId is required' });
          if (!await guardRun(req, res, runId, PROJECT_TOKENS.diffReview)) return undefined;
          const actor = (req as any).session?.UserAP?.login ?? (req as any).user?.login ?? 'admin';
          const diff = await AgentPipelineService.applyStoredDiff(runId, String(actor));
          return res.json({ data: diff.toJSON() });
        }

        if (method === 'cancelRun') {
          const runId = str(req.body?.runId);
          if (!runId) return res.status(400).json({ message: 'runId is required' });
          if (!await guardRun(req, res, runId, PROJECT_TOKENS.runOperate)) return undefined;
          const run = await AgentPipelineService.cancelRun(runId);
          return res.json({ data: run.toJSON() });
        }

        if (method === 'approveWorkspaceProposal') {
          if (!await guardProposal(req, res, str(req.body?.proposalId), PROJECT_TOKENS.diffReview)) return undefined;
          const proposal = await AgentWorkspaceProposalService.approve(
            str(req.body?.proposalId), Number(req.body?.revision), actorOf(req).name,
            { targetBranch: str(req.body?.targetBranch) || undefined, commitMessage: str(req.body?.commitMessage) || undefined },
          );
          return res.json({ data: proposal.toJSON() });
        }

        if (method === 'continueWorkspaceProposal') {
          if (!await guardProposal(req, res, str(req.body?.proposalId), PROJECT_TOKENS.diffReview)) return undefined;
          const run = await AgentWorkspaceProposalService.continueWork(
            str(req.body?.proposalId), Number(req.body?.revision), actorOf(req), str(req.body?.comment),
          );
          return res.json({ data: run.toJSON() });
        }

        if (method === 'rejectWorkspaceProposal') {
          if (!await guardProposal(req, res, str(req.body?.proposalId), PROJECT_TOKENS.diffReview)) return undefined;
          const proposal = await AgentWorkspaceProposalService.reject(
            str(req.body?.proposalId), Number(req.body?.revision), actorOf(req).name,
          );
          return res.json({ data: proposal.toJSON() });
        }

        // Deliberately takes no revision: this is the exit from the statuses where nobody is
        // reviewing anything, and refusing it over a stale revision would keep the directory locked
        // for the sake of an optimistic check on a decision that is not being made.
        if (method === 'releaseWorkspaceProposal') {
          if (!await guardProposal(req, res, str(req.body?.proposalId), PROJECT_TOKENS.diffReview)) return undefined;
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
        // «Нужен ответ» became one tab of «Входящие», which shows the other nine kinds of waiting
        // row beside the agent's questions.
        return legacyRedirect(req, res, 'inbox');
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
