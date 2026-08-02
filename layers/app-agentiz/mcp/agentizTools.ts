import type { IMcpTool } from '@nodeknit/app-mcp';
import { AgentProject } from '../models/AgentProject';
import { AgentRole } from '../models/AgentRole';
import { PipelineSpec } from '../models/PipelineSpec';
import { AgentTask } from '../models/AgentTask';
import { AgentRun } from '../models/AgentRun';
import { AgentStageExecution } from '../models/AgentStageExecution';
import { AgentRunLog } from '../models/AgentRunLog';
import { AgentPipelineService } from '../services/AgentPipelineService';
import { GitSyncService } from '../services/GitSyncService';

type Params = Record<string, unknown>;

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;

function objectParams(params: unknown): Params {
  return params !== null && typeof params === 'object' && !Array.isArray(params) ? params as Params : {};
}

function stringParam(params: Params, name: string): string | undefined {
  const value = params[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function limitParam(params: Params, fallback = LIMIT_DEFAULT): number {
  const raw = params.limit;
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : fallback;
  return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 1), LIMIT_MAX) : fallback;
}

function projectTeaser(project: AgentProject) {
  return {
    id: project.id, slug: project.slug, name: project.name, repoProvider: project.repoProvider,
    repository: project.repoConfig ? `${project.repoConfig.owner}/${project.repoConfig.repo}` : null,
    defaultBranch: project.repoConfig?.defaultBranch ?? null, isActive: project.isActive,
    lastSyncedAt: project.lastSyncedAt, updatedAt: project.updatedAt,
  };
}

function taskTeaser(task: AgentTask) {
  return {
    id: task.id, projectId: task.projectId, externalId: task.externalId, title: task.title,
    status: task.status, externalStatus: task.externalStatus, tags: task.tags ?? [], externalUrl: task.externalUrl,
    pipelineSpecId: task.pipelineSpecId, updatedAt: task.updatedAt,
  };
}

function runTeaser(run: AgentRun) {
  return {
    id: run.id, taskId: run.taskId, projectId: run.projectId, status: run.status, trigger: run.trigger,
    currentStageIndex: run.currentStageIndex, startedAt: run.startedAt, finishedAt: run.finishedAt,
    resultSummary: run.resultSummary, errorMessage: run.errorMessage, commitUrl: run.commitUrl,
    responseUrl: run.responseUrl, createdAt: run.createdAt,
  };
}

const overviewTool: IMcpTool = {
  name: 'agentiz.overview',
  group: 'agentiz',
  groupDescription: 'Inspect Agentiz projects, task routing, pipeline runs, execution stages and logs.',
  shortDescription: 'Compact health and workload overview of all Agentiz projects.',
  description: 'Returns a compact operational overview: projects, task/run status counters and currently running work. Use this first when investigating Agentiz.',
  mode: 'protected',
  inputSchema: { type: 'object', properties: {} },
  async handler() {
    const [projects, tasks, runs] = await Promise.all([
      AgentProject.findAll({ order: [['createdAt', 'DESC']] }),
      AgentTask.findAll({ attributes: ['status'] }),
      AgentRun.findAll({ where: { status: 'running' }, order: [['startedAt', 'ASC']], limit: LIMIT_MAX }),
    ]);
    const countBy = (items: Array<{ status: string }>) => items.reduce<Record<string, number>>((result, item) => {
      result[item.status] = (result[item.status] ?? 0) + 1;
      return result;
    }, {});
    return {
      projects: projects.map(projectTeaser),
      taskCounts: countBy(tasks),
      runningRuns: runs.map(runTeaser),
      timestamp: new Date().toISOString(),
    };
  },
};

const projectsTool: IMcpTool = {
  name: 'agentiz.projects', group: 'agentiz',
  shortDescription: 'Lists projects without credentials or other secrets.',
  description: 'Lists Agentiz projects and their sync state. Secrets and tracker tokens are never returned.',
  mode: 'protected', inputSchema: { type: 'object', properties: {} },
  async handler() {
    const projects = await AgentProject.findAll({ order: [['createdAt', 'DESC']] });
    return { count: projects.length, items: projects.map(projectTeaser) };
  },
};

const tasksTool: IMcpTool = {
  name: 'agentiz.tasks', group: 'agentiz',
  shortDescription: 'Lists compact task teasers, filterable by project and pipeline status.',
  description: 'Lists compact Agentiz task teasers. Filter by projectId and status; use agentiz.taskDetails only when a task needs closer inspection.',
  mode: 'protected',
  inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, status: { type: 'string' }, limit: { type: 'integer', default: 50, maximum: 200 } } },
  async handler(params) {
    const payload = objectParams(params);
    const projectId = stringParam(payload, 'projectId');
    const status = stringParam(payload, 'status');
    const where = { ...(projectId ? { projectId } : {}), ...(status ? { status } : {}) };
    const tasks = await AgentTask.findAll({ where, order: [['updatedAt', 'DESC']], limit: limitParam(payload) });
    return { count: tasks.length, items: tasks.map(taskTeaser) };
  },
};

const runsTool: IMcpTool = {
  name: 'agentiz.runs', group: 'agentiz',
  shortDescription: 'Lists compact pipeline-run teasers, filterable by task, project and status.',
  description: 'Lists compact Agentiz pipeline runs. Use agentiz.runDetails for stage outputs and logs of one selected run.',
  mode: 'protected',
  inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, projectId: { type: 'string' }, status: { type: 'string' }, limit: { type: 'integer', default: 50, maximum: 200 } } },
  async handler(params) {
    const payload = objectParams(params);
    const taskId = stringParam(payload, 'taskId');
    const projectId = stringParam(payload, 'projectId');
    const status = stringParam(payload, 'status');
    const where = { ...(taskId ? { taskId } : {}), ...(projectId ? { projectId } : {}), ...(status ? { status } : {}) };
    const runs = await AgentRun.findAll({ where, order: [['createdAt', 'DESC']], limit: limitParam(payload) });
    return { count: runs.length, items: runs.map(runTeaser) };
  },
};

const runDetailsTool: IMcpTool = {
  name: 'agentiz.runDetails', group: 'agentiz',
  shortDescription: 'Returns stages and bounded logs for one run; full stage payloads are opt-in.',
  description: 'Returns complete execution state for one run: stage statuses and recent logs. Stage input/output is omitted by default to conserve context; set includePayloads=true only for the selected run.',
  mode: 'protected',
  inputSchema: { type: 'object', required: ['runId'], properties: { runId: { type: 'string' }, logLimit: { type: 'integer', default: 100, maximum: 200 }, includePayloads: { type: 'boolean', default: false } } },
  async handler(params) {
    const payload = objectParams(params);
    const runId = stringParam(payload, 'runId');
    if (!runId) throw new Error('runId:string is required');
    const run = await AgentRun.findByPk(runId);
    if (!run) throw new Error(`AgentRun ${runId} not found`);
    const includePayloads = payload.includePayloads === true;
    const [stages, logs] = await Promise.all([
      AgentStageExecution.findAll({ where: { runId }, order: [['stageIndex', 'ASC']] }),
      AgentRunLog.findAll({ where: { runId }, order: [['createdAt', 'ASC']], limit: limitParam({ ...payload, limit: payload.logLimit }, 100) }),
    ]);
    return {
      run: runTeaser(run),
      stages: stages.map((stage) => ({
        id: stage.id, stageIndex: stage.stageIndex, role: stage.role, agentRoleId: stage.agentRoleId,
        status: stage.status, startedAt: stage.startedAt, finishedAt: stage.finishedAt, errorMessage: stage.errorMessage,
        ...(includePayloads ? { input: stage.input, output: stage.output } : {}),
      })),
      logs: logs.map((log) => ({ id: log.id, stageExecutionId: log.stageExecutionId, level: log.level, message: log.message, meta: log.meta, createdAt: log.createdAt })),
      payloadsIncluded: includePayloads,
    };
  },
};

const configurationTool: IMcpTool = {
  name: 'agentiz.configuration', group: 'agentiz',
  shortDescription: 'Shows roles and pipeline-spec summaries for a project.',
  description: 'Shows Agentiz roles and pipeline specifications for one project. This exposes configuration needed to diagnose routing without exposing project credentials.',
  mode: 'protected',
  inputSchema: { type: 'object', required: ['projectId'], properties: { projectId: { type: 'string' }, includeSpecs: { type: 'boolean', default: false } } },
  async handler(params) {
    const payload = objectParams(params);
    const projectId = stringParam(payload, 'projectId');
    if (!projectId) throw new Error('projectId:string is required');
    const [roles, specs] = await Promise.all([
      AgentRole.findAll({ where: { projectId }, order: [['key', 'ASC']] }),
      PipelineSpec.findAll({ where: { projectId }, order: [['updatedAt', 'DESC']] }),
    ]);
    return {
      roles: roles.map((role) => ({ id: role.id, key: role.key, title: role.title, model: role.model, allowedTools: role.allowedTools ?? [], updatedAt: role.updatedAt })),
      pipelineSpecs: specs.map((spec) => ({ id: spec.id, name: spec.name, isActive: spec.isActive, isDefault: spec.isDefault, version: spec.version, matchTags: spec.matchTags, updatedAt: spec.updatedAt, ...(payload.includeSpecs === true ? { spec: spec.spec } : {}) })),
      specsIncluded: payload.includeSpecs === true,
    };
  },
};

const syncTool: IMcpTool = {
  name: 'agentiz.sync', group: 'agentiz-actions',
  groupDescription: 'State-changing Agentiz operations. Inspect the target first and call deliberately.',
  shortDescription: 'Synchronizes one project or all active projects from its tracker.',
  description: 'Starts a tracker synchronization. This changes local task data; provide projectId for one project, or all=true for every active project.',
  mode: 'protected',
  inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, all: { type: 'boolean' } } },
  async handler(params) {
    const payload = objectParams(params);
    const projectId = stringParam(payload, 'projectId');
    if (projectId) return GitSyncService.syncProject(projectId);
    if (payload.all === true) return GitSyncService.syncAllActiveProjects();
    throw new Error('projectId:string or all:true is required');
  },
};

const runTaskTool: IMcpTool = {
  name: 'agentiz.runTask', group: 'agentiz-actions',
  shortDescription: 'Queues the pipeline for one task.',
  description: 'Creates a pipeline run for taskId and queues a worker job. Completion may create commits, pull requests or tracker comments according to the selected pipeline specification.',
  mode: 'protected', inputSchema: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } } },
  async handler(params) {
    const taskId = stringParam(objectParams(params), 'taskId');
    if (!taskId) throw new Error('taskId:string is required');
    return runTeaser(await AgentPipelineService.runTask(taskId, 'manual'));
  },
};

const cancelRunTool: IMcpTool = {
  name: 'agentiz.cancelRun', group: 'agentiz-actions',
  shortDescription: 'Cancels an unfinished pipeline run.',
  description: 'Cancels a pending or running pipeline run and marks its task cancelled. This changes Agentiz state.',
  mode: 'protected', inputSchema: { type: 'object', required: ['runId'], properties: { runId: { type: 'string' }, reason: { type: 'string' } } },
  async handler(params) {
    const payload = objectParams(params);
    const runId = stringParam(payload, 'runId');
    if (!runId) throw new Error('runId:string is required');
    return runTeaser(await AgentPipelineService.cancelRun(runId, stringParam(payload, 'reason')));
  },
};

export const agentizMcpTools: IMcpTool[] = [overviewTool, projectsTool, tasksTool, runsTool, runDetailsTool, configurationTool, syncTool, runTaskTool, cancelRunTool];
