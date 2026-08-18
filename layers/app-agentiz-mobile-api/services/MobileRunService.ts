import { Op } from 'sequelize';
import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { AgentRun } from '../../app-agentiz/models/AgentRun';
import { AgentRunInteraction } from '../../app-agentiz/models/AgentRunInteraction';
import { AgentRunLog } from '../../app-agentiz/models/AgentRunLog';
import { AgentStageExecution } from '../../app-agentiz/models/AgentStageExecution';
import { AgentTask } from '../../app-agentiz/models/AgentTask';
import { runUsage } from '../../app-agentiz/lib/runUsage';

/** A run is "in flight" while it is in one of these states — including the paused `waiting_input`. */
const ACTIVE_RUN_STATUSES = ['pending', 'running', 'waiting_input'];

/**
 * Runs across every project the caller owns — the app's counterpart to the dashboard's "Запуски"
 * board. `MobileTaskService` already serves a run *within* a task; this one answers the question
 * that has no task in hand yet: what is running right now, anywhere.
 *
 * Scope is the same ownership rule the rest of the layer applies: the project ids are resolved
 * first and every query is bounded by them, so a run of somebody else's project is never read, let
 * alone reported.
 */
export class MobileRunService {
  private static async ownedProjectIds(ownerId: number | string): Promise<string[]> {
    const projects = await AgentProject.findAll({ where: { ownerId: ownerId as any }, attributes: ['id'] });
    return projects.map((project) => project.id);
  }

  /**
   * Everything in flight plus the last finished runs. Each row carries what makes a running agent
   * legible in a list — its stages, its newest log line and whether it is parked on a question — so
   * the screen does not have to open a run to say what is happening in it.
   */
  static async board(ownerId: number | string) {
    const projectIds = await this.ownedProjectIds(ownerId);
    if (projectIds.length === 0) return { active: [], recent: [] };

    const scope = { projectId: { [Op.in]: projectIds } };
    const [active, recent] = await Promise.all([
      AgentRun.findAll({
        where: { ...scope, status: { [Op.in]: ACTIVE_RUN_STATUSES } },
        order: [['createdAt', 'DESC']],
        limit: 50,
      }),
      AgentRun.findAll({
        where: { ...scope, status: { [Op.notIn]: ACTIVE_RUN_STATUSES } },
        order: [['createdAt', 'DESC']],
        limit: 20,
      }),
    ]);
    const runs = [...active, ...recent];
    if (runs.length === 0) return { active: [], recent: [] };

    const runIds = runs.map((run) => run.id);
    const activeIds = active.map((run) => run.id);
    const [stages, tasks, projects, interactions, logs] = await Promise.all([
      AgentStageExecution.findAll({ where: { runId: { [Op.in]: runIds } }, order: [['stageIndex', 'ASC']] }),
      AgentTask.findAll({ where: { id: { [Op.in]: [...new Set(runs.map((run) => run.taskId))] } } }),
      AgentProject.findAll({ where: { id: { [Op.in]: [...new Set(runs.map((run) => run.projectId))] } } }),
      AgentRunInteraction.findAll({ where: { runId: { [Op.in]: runIds }, status: 'pending' } }),
      // Only live runs get a "last line": for a finished one `resultSummary` says more, and the log
      // table is by far the biggest one queried here.
      activeIds.length > 0
        ? AgentRunLog.findAll({ where: { runId: { [Op.in]: activeIds } }, order: [['createdAt', 'DESC']], limit: 300 })
        : Promise.resolve([] as AgentRunLog[]),
    ]);

    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const stagesByRun = new Map<string, AgentStageExecution[]>();
    for (const stage of stages) {
      const list = stagesByRun.get(stage.runId) ?? [];
      list.push(stage);
      stagesByRun.set(stage.runId, list);
    }
    const pendingByRun = new Map<string, number>();
    for (const interaction of interactions) {
      pendingByRun.set(interaction.runId, (pendingByRun.get(interaction.runId) ?? 0) + 1);
    }
    // Newest first, so the first row seen for a run is its latest line.
    const lastLogByRun = new Map<string, AgentRunLog>();
    for (const log of logs) {
      if (!lastLogByRun.has(log.runId)) lastLogByRun.set(log.runId, log);
    }

    const row = (run: AgentRun) => {
      const lastLog = lastLogByRun.get(run.id);
      return {
        id: run.id,
        status: run.status,
        trigger: run.trigger,
        resultSummary: run.resultSummary,
        errorMessage: run.errorMessage,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        createdAt: run.createdAt,
        // The app opens a run through its task, so a board row without a task id is not navigable.
        taskId: run.taskId,
        taskTitle: taskById.get(run.taskId)?.title ?? null,
        projectId: run.projectId,
        projectName: projectById.get(run.projectId)?.name ?? null,
        stages: (stagesByRun.get(run.id) ?? []).map((stage) => ({ role: stage.role, status: stage.status })),
        pendingInteractions: pendingByRun.get(run.id) ?? 0,
        lastLog: lastLog ? { level: lastLog.level, message: lastLog.message, createdAt: lastLog.createdAt } : null,
        // Token spend accumulated across attempts; null until a worker result reports usage.
        usage: runUsage(run),
      };
    };

    return { active: active.map(row), recent: recent.map(row) };
  }
}
