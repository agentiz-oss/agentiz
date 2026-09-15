import { Op } from 'sequelize';
import { AgentRun } from '../models/AgentRun';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentRunLog } from '../models/AgentRunLog';
import { AgentRunInteraction } from '../models/AgentRunInteraction';
import { AgentStageExecution } from '../models/AgentStageExecution';
import { AgentWorker } from '../models/AgentWorker';
import { AgentProject } from '../models/AgentProject';
import { AgentTask } from '../models/AgentTask';
import { PipelineSpec } from '../models/PipelineSpec';
import { runUsage } from './runUsage';

/**
 * The run board, as one query pair.
 *
 * Its own file rather than a function inside the route table, because two callers read it now: the
 * `_method=listRuns` endpoint the screen polls, and `lib/panel/render.ts`, which answers the first
 * paint from the same shape. A panel renderer importing a route table would drag every service
 * behind it into places that only want a list of runs.
 */

/** A run is "in flight" while it is in one of these states — the board's top section. */
const ACTIVE_RUN_STATUSES = ['pending', 'running', 'waiting_input'];

/**
 * The run board: everything currently in flight plus the last finished runs, in one payload.
 * Each row carries what makes a running agent legible without opening it — its stages, the worker
 * that claimed the job, the newest log line and whether it is blocked on a question.
 *
 * `status` narrows both halves to one stored value. It exists because the board's second half is
 * capped at the last 25 runs: a filter applied in the browser over that window would answer
 * «упавших нет» while the failure it is looking for sits at position 30. No status = the query
 * pair, the limits and the payload of before this parameter existed — pinned by the first test in
 * `runBoard.test.ts`, because `_method=listRuns` is a public shape and not only this screen's.
 */
export async function listRuns(projectId: string, visibleProjectIds?: string[], status?: string) {
  // One project when the caller named one (its right has been checked), otherwise every project
  // they may see. This endpoint reads Sequelize directly, so the panel's access graph — which
  // only covers generic CRUD — never sees it.
  const scope = projectId ? { projectId } : visibleProjectIds ? { projectId: visibleProjectIds } : {};
  const filtered = Boolean(status);
  const wantsActive = !status || ACTIVE_RUN_STATUSES.includes(status);
  const wantsFinished = !status || !ACTIVE_RUN_STATUSES.includes(status);
  const [active, recent, total] = await Promise.all([
    wantsActive
      ? AgentRun.findAll({
          where: { ...scope, status: status ? status : { [Op.in]: ACTIVE_RUN_STATUSES } },
          order: [['createdAt', 'DESC']],
          limit: 100,
        })
      : Promise.resolve([] as AgentRun[]),
    wantsFinished
      ? AgentRun.findAll({
          where: { ...scope, status: status ? status : { [Op.notIn]: ACTIVE_RUN_STATUSES } },
          order: [['createdAt', 'DESC']],
          limit: filtered ? 100 : 25,
        })
      : Promise.resolve([] as AgentRun[]),
    // What the header prints beside the list, so «5 показано» never reads as «5 всего».
    AgentRun.count({ where: scope }),
  ]);
  const runs = [...active, ...recent];
  if (runs.length === 0) return { active: [], recent: [], total };

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
  const specIds = [...new Set(runs.map((run) => run.pipelineSpecId).filter((id): id is string => Boolean(id)))];
  const [workers, specs] = await Promise.all([
    workerIds.length > 0 ? AgentWorker.findAll({ where: { id: workerIds } }) : Promise.resolve([]),
    specIds.length > 0 ? PipelineSpec.findAll({ where: { id: specIds }, attributes: ['id', 'name'] }) : Promise.resolve([]),
  ]);

  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const projectMap = new Map(projects.map((project) => [project.id, project]));
  const workerMap = new Map(workers.map((worker) => [worker.id, worker]));
  const specMap = new Map(specs.map((spec) => [spec.id, spec.name]));
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
      verdict: run.verdict,
      // Why a run that has neither finished nor moved is not moving. Deliberately not a status
      // (AGENTS.md): it is a property of the wait, and the screen prints it beside the status.
      waitingReason: run.waitingReason,
      waitingUntil: run.waitingUntil,
      branch: run.branch,
      task: taskMap.get(run.taskId) ? { id: run.taskId, title: taskMap.get(run.taskId)!.title } : null,
      // The slug is what a panel address is built from — a row that carried only the id would put
      // route-building back into the module, which is the one thing `routeTree.ts` exists to stop.
      project: projectMap.get(run.projectId)
        ? { id: run.projectId, name: projectMap.get(run.projectId)!.name, slug: projectMap.get(run.projectId)!.slug }
        : null,
      pipeline: run.pipelineSpecId ? { id: run.pipelineSpecId, name: specMap.get(run.pipelineSpecId) ?? null } : null,
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

  return { active: active.map(toCard), recent: recent.map(toCard), total };
}
