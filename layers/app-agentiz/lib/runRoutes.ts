import type { AdminizerRouteMiddleware } from '@nodeknit/app-adminizer';
import { AgentRun } from '../models/AgentRun';
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

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
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
 * One run in full: its stages, its logs and — when the pipeline changed code — the diff, with a
 * button to apply it. Its own page rather than an inline panel on the task screen, because a run
 * with a large patch and a full log needs the room.
 */
export const runRoutes: AdminizerRouteMiddleware[] = [
  {
    route: '/agentiz-runs',
    method: 'get',
    handler: async (req, res) => {
      const method = str(req.query._method);

      if (method === 'getRunDetails') {
        const runId = str(req.query.runId);
        if (!runId) return res.status(400).json({ message: 'runId is required' });
        const run = await AgentRun.findByPk(runId);
        if (!run) return res.status(404).json({ message: 'Run not found' });
        const stages = await AgentStageExecution.findAll({
          where: { runId },
          order: [['stageIndex', 'ASC']],
        });
        const logs = await AgentRunLog.findAll({
          where: { runId },
          order: [['createdAt', 'ASC']],
          limit: 500,
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
            stages: stages.map((stage) => stage.toJSON()),
            logs: logs.map((log) => log.toJSON()),
            diff: diff?.toJSON() ?? null,
            interactions: interactions.map((interaction) => interaction.toJSON()),
            proposal: workspaceReview?.proposal.toJSON() ?? null,
            revisions: workspaceReview?.revisions.map((revision) => revision.toJSON()) ?? [],
            latestDiff: latestWorkspaceDiff?.toJSON() ?? null,
          },
        });
      }

      return req.Inertia.render({
        component: 'module',
        props: { moduleComponent: adminizerModuleUrl('AgentizRunDetail') },
      });
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
