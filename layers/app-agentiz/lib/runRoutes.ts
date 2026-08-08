import type { AdminizerRouteMiddleware } from '@nodeknit/app-adminizer';
import { AgentRun } from '../models/AgentRun';
import { AgentStageExecution } from '../models/AgentStageExecution';
import { AgentRunLog } from '../models/AgentRunLog';
import { AgentRunDiff } from '../models/AgentRunDiff';
import { AgentPipelineService } from '../services/AgentPipelineService';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
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
        return res.json({
          data: {
            run: run.toJSON(),
            stages: stages.map((stage) => stage.toJSON()),
            logs: logs.map((log) => log.toJSON()),
            diff: diff?.toJSON() ?? null,
          },
        });
      }

      return req.Inertia.render({
        component: 'module',
        props: { moduleComponent: '/dashboard/modules/AgentizRunDetail.js' },
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

        return res.status(400).json({ message: `Unknown _method: ${method || '(none)'}` });
      } catch (error: any) {
        return res.status(400).json({ message: error?.message ?? String(error) });
      }
    },
  },
];
