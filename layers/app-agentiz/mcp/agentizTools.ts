import type { IMcpTool } from '@nodeknit/app-mcp';
import { Op } from 'sequelize';
import { AgentProject } from '../models/AgentProject';
import { AgentRole } from '../models/AgentRole';
import { PipelineSpec } from '../models/PipelineSpec';
import { AgentTask } from '../models/AgentTask';
import { AgentRun } from '../models/AgentRun';
import { AgentStageExecution } from '../models/AgentStageExecution';
import { listRunLogs } from '../lib/runLogs';
import { runUsage } from '../lib/runUsage';
import { normalizeRunOverride, REASONING_LEVELS } from '../lib/harnessCatalog';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentWorker } from '../models/AgentWorker';
import { AgentPipelineService } from '../services/AgentPipelineService';
import { GitSyncService } from '../services/GitSyncService';
import { AgentWorkerApiService } from '../services/AgentWorkerApiService';
import { AgentWorkerQueueService } from '../services/AgentWorkerQueueService';
import { pipelineSpecSchema, PIPELINE_SPEC_RULES } from '../services/PipelineSpecValidation';
import { AgentCapacityService } from '../services/AgentCapacityService';
import { capacityOverview, usageHistory, workerHarnessView } from '../lib/capacityViews';
import { manageBusinessDataTool, manageWorkerTool } from './agentizManagementTools';
import { agentizProposalMcpTools } from './agentizProposalTools';
import { agentizCapacityActionTools } from './agentizCapacityTools';
import { notificationPolicyMcpTools } from './notificationPolicyTools';
import { agentizWorkflowMcpTools } from './agentizWorkflowTools';

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

/**
 * resultSummary is agent-authored prose and can run to several KB (a whole worklog per run); across
 * a list of runs that dwarfs everything else in the payload. Omitted by default — callers see
 * resultSummaryLength and fetch the text itself only for the run(s) they actually need, either via
 * `includeSummary` on the list or by calling agentiz.runDetails for one run.
 */
function runTeaser(run: AgentRun, opts: { includeSummary?: boolean } = {}) {
  const includeSummary = opts.includeSummary ?? true;
  return {
    id: run.id, taskId: run.taskId, projectId: run.projectId, status: run.status, trigger: run.trigger,
    currentStageIndex: run.currentStageIndex, startedAt: run.startedAt, finishedAt: run.finishedAt,
    ...(includeSummary ? { resultSummary: run.resultSummary } : {
      resultSummaryLength: run.resultSummary?.length ?? 0,
      ...(run.resultSummary ? { resultSummaryHint: `Omitted (${run.resultSummary.length} chars). Call agentiz.runs with includeSummary=true, or agentiz.runDetails {runId:"${run.id}"}, to get it.` } : {}),
    }),
    errorMessage: run.errorMessage, commitUrl: run.commitUrl,
    responseUrl: run.responseUrl, createdAt: run.createdAt,
    // Machine-readable pass/fail off a verdict stage's own output; null covers both "no stage
    // asked" and "asked but got nothing usable back" — see lib/runVerdict.ts.
    verdict: run.verdict, verdictReason: run.verdictReason,
    // Set while the run is parked (harness limit / schedule window); the status itself stays
    // running/pending, so this pair is what distinguishes "waiting" from "hung".
    waitingReason: run.waitingReason, waitingUntil: run.waitingUntil,
    // Token spend accumulated across attempts; null until the first worker result reports usage.
    usage: runUsage(run),
  };
}

/** Deliberately excludes token fields, IP address and the job snapshot (which can contain task data). */
function workerTeaser(worker: AgentWorker) {
  return {
    id: worker.id, name: worker.name, kind: worker.kind, status: worker.status,
    contactState: worker.contactState(), instanceId: worker.instanceId,
    // The directories a worker_workspace pipeline can name. Without them a caller can see that a
    // worker exists but not that it is the one holding the directory the pipeline is about.
    workspaces: worker.workspaces ?? [],
    // The push grant, and the reason a `commit` pipeline on this worker either works or does not.
    gitPushRoots: worker.gitPushRoots ?? [],
    allowedProjectIds: worker.allowedProjectIds ?? null,
    allowedRepositoryIds: worker.allowedRepositoryIds ?? null,
    capabilities: worker.capabilities ?? null,
    maxConcurrentJobs: worker.effectiveMaxConcurrentJobs(),
    activeHours: worker.activeHours ?? null,
    timezone: worker.timezone ?? null,
    version: worker.version, hostname: worker.hostname, registeredAt: worker.registeredAt,
    lastSeenAt: worker.lastSeenAt, lastClaimAt: worker.lastClaimAt,
    claimedJobsCount: worker.claimedJobsCount, revokedAt: worker.revokedAt,
    createdAt: worker.createdAt, updatedAt: worker.updatedAt,
  };
}

/** Job snapshots and results may contain task content, so the debugging listing exposes only routing state. */
function jobTeaser(job: AgentRunJob) {
  return {
    id: job.id, runId: job.runId, projectId: job.projectId, status: job.status,
    priority: job.priority, attempt: job.attempt, workerId: job.workerId,
    harnessKey: job.harnessKey, deferReason: job.deferReason, deferredCount: job.deferredCount,
    lockedUntil: job.lockedUntil, availableAt: job.availableAt,
    cancelRequestedAt: job.cancelRequestedAt, lastError: job.lastError,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
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
      // gitSha/buildTime come from the Docker build args (see container.yml); processStartedAt is
      // derived from uptime so a redeploy loop can tell "still the old process" from "new build,
      // not restarted yet" apart from "new build, running" without guessing from timestamps alone.
      server: {
        gitSha: process.env.GIT_SHA ?? null,
        buildTime: process.env.BUILD_TIME ?? null,
        processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        uptimeSec: Math.round(process.uptime()),
      },
      workerRuntime: {
        workerApiEnabled: AgentWorkerApiService.isEnabled(),
        localWorkerEnabled: AgentWorkerQueueService.isEnabled(),
      },
      projects: projects.map(projectTeaser),
      taskCounts: countBy(tasks),
      runningRuns: runs.map((run) => runTeaser(run)),
      timestamp: new Date().toISOString(),
    };
  },
};

const workersTool: IMcpTool = {
  name: 'agentiz.workers', group: 'agentiz',
  shortDescription: 'Lists worker identities, their availability and last activity.',
  description: 'Lists registered local and external workers. contactState is derived from lastSeenAt (online means seen within five minutes); no worker token or IP address is returned.',
  mode: 'protected',
  inputSchema: { type: 'object', properties: { status: { type: 'string' }, kind: { type: 'string' }, limit: { type: 'integer', default: 50, maximum: 200 } } },
  async handler(params) {
    const payload = objectParams(params);
    const status = stringParam(payload, 'status');
    const kind = stringParam(payload, 'kind');
    const where = { ...(status ? { status } : {}), ...(kind ? { kind } : {}) };
    const workers = await AgentWorker.findAll({ where, order: [['lastSeenAt', 'DESC NULLS LAST'], ['createdAt', 'DESC']], limit: limitParam(payload) });
    return {
      count: workers.length,
      runtime: { workerApiEnabled: AgentWorkerApiService.isEnabled(), localWorkerEnabled: AgentWorkerQueueService.isEnabled() },
      items: workers.map(workerTeaser),
    };
  },
};

const workerDetailsTool: IMcpTool = {
  name: 'agentiz.workerDetails', group: 'agentiz',
  shortDescription: 'Returns one worker and its recent job history.',
  description: 'Returns detailed safe telemetry for one worker plus recent jobs it claimed. Use it to diagnose a worker that is offline, paused or holding a lease.',
  mode: 'protected',
  inputSchema: { type: 'object', required: ['workerId'], properties: { workerId: { type: 'string' }, jobLimit: { type: 'integer', default: 50, maximum: 200 } } },
  async handler(params) {
    const payload = objectParams(params);
    const workerId = stringParam(payload, 'workerId');
    if (!workerId) throw new Error('workerId:string is required');
    const worker = await AgentWorker.findByPk(workerId);
    if (!worker) throw new Error(`AgentWorker ${workerId} not found`);
    const jobs = await AgentRunJob.findAll({
      where: { workerId }, order: [['updatedAt', 'DESC']],
      limit: limitParam({ ...payload, limit: payload.jobLimit }),
    });
    const jobCounts = jobs.reduce<Record<string, number>>((counts, job) => {
      counts[job.status] = (counts[job.status] ?? 0) + 1;
      return counts;
    }, {});
    // Queue of this worker with an ETA: a job "hanging for a week" must read as scheduled, not stuck.
    const pinnedQueue = await AgentRunJob.findAll({
      where: { requiredWorkerId: workerId, status: { [Op.in]: ['queued', 'released'] } },
      order: [['priority', 'ASC'], ['createdAt', 'ASC']],
      limit: 20,
    });
    const queue = [] as Array<Record<string, unknown>>;
    for (const job of pinnedQueue) {
      const eta = await AgentCapacityService.nextEligibleAt(job);
      queue.push({ ...jobTeaser(job), nextEligibleAt: eta.at, etaIsEstimate: eta.estimate, etaReasons: eta.reasons });
    }
    return {
      worker: workerTeaser(worker),
      harnesses: await workerHarnessView(worker),
      pinnedQueue: queue,
      recentJobCounts: jobCounts,
      recentJobs: jobs.map(jobTeaser),
    };
  },
};

const jobsTool: IMcpTool = {
  name: 'agentiz.jobs', group: 'agentiz',
  shortDescription: 'Lists worker-queue jobs and their lease state.',
  description: 'Lists queue jobs to diagnose work that is waiting, leased or failed. Job snapshots and results are omitted because they may contain task content.',
  mode: 'protected',
  inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, runId: { type: 'string' }, workerId: { type: 'string' }, status: { type: 'string' }, limit: { type: 'integer', default: 50, maximum: 200 } } },
  async handler(params) {
    const payload = objectParams(params);
    const projectId = stringParam(payload, 'projectId');
    const runId = stringParam(payload, 'runId');
    const workerId = stringParam(payload, 'workerId');
    const status = stringParam(payload, 'status');
    const where = { ...(projectId ? { projectId } : {}), ...(runId ? { runId } : {}), ...(workerId ? { workerId } : {}), ...(status ? { status } : {}) };
    const jobs = await AgentRunJob.findAll({ where, order: [['createdAt', 'DESC']], limit: limitParam(payload) });
    return { count: jobs.length, items: jobs.map(jobTeaser) };
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
  description: 'Lists compact Agentiz pipeline runs. resultSummary is omitted by default (resultSummaryLength shows whether one exists) since it can be several KB of prose per run; set includeSummary=true to get it back, or call agentiz.runDetails for a single run.',
  mode: 'protected',
  inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, projectId: { type: 'string' }, status: { type: 'string' }, limit: { type: 'integer', default: 50, maximum: 200 }, includeSummary: { type: 'boolean', default: false } } },
  async handler(params) {
    const payload = objectParams(params);
    const taskId = stringParam(payload, 'taskId');
    const projectId = stringParam(payload, 'projectId');
    const status = stringParam(payload, 'status');
    const includeSummary = payload.includeSummary === true;
    const where = { ...(taskId ? { taskId } : {}), ...(projectId ? { projectId } : {}), ...(status ? { status } : {}) };
    const runs = await AgentRun.findAll({ where, order: [['createdAt', 'DESC']], limit: limitParam(payload) });
    return { count: runs.length, items: runs.map((run) => runTeaser(run, { includeSummary })), summaryIncluded: includeSummary };
  },
};

const runDetailsTool: IMcpTool = {
  name: 'agentiz.runDetails', group: 'agentiz',
  shortDescription: 'Returns stages and the tail of the log for one run; full stage payloads are opt-in.',
  description: 'Returns complete execution state for one run: stage statuses and the newest log lines. Logs are the tail, not the beginning — a running agent streams its tool calls, so a long run has far more lines than logLimit. Pass after=<logsCursor from a previous call> to get only what arrived since, or before=<logsEarlierCursor> to walk back towards the start. Stage input/output is omitted by default to conserve context; set includePayloads=true only for the selected run.',
  mode: 'protected',
  inputSchema: { type: 'object', required: ['runId'], properties: { runId: { type: 'string' }, logLimit: { type: 'integer', default: 100, maximum: 200 }, after: { type: 'string', description: 'logsCursor from an earlier call: returns only lines newer than it.' }, before: { type: 'string', description: 'logsEarlierCursor from an earlier call: returns the page just before it.' }, includePayloads: { type: 'boolean', default: false } } },
  async handler(params) {
    const payload = objectParams(params);
    const runId = stringParam(payload, 'runId');
    if (!runId) throw new Error('runId:string is required');
    const run = await AgentRun.findByPk(runId);
    if (!run) throw new Error(`AgentRun ${runId} not found`);
    const includePayloads = payload.includePayloads === true;
    const [stages, logPage, job] = await Promise.all([
      AgentStageExecution.findAll({ where: { runId }, order: [['stageIndex', 'ASC']] }),
      listRunLogs(runId, {
        after: stringParam(payload, 'after') || null,
        before: stringParam(payload, 'before') || null,
        limit: limitParam({ ...payload, limit: payload.logLimit }, 100),
      }),
    AgentRunJob.findOne({ where: { runId, jobKind: 'pipeline' } }),
    ]);
    const logs = logPage.logs;
    // A parked job gets its ETA: "run started but nothing happens" then reads as "deferred until…".
    const eta = job && ['queued', 'released'].includes(job.status)
      ? await AgentCapacityService.nextEligibleAt(job)
      : null;
    return {
      run: runTeaser(run),
      ...(eta ? { nextEligibleAt: eta.at, etaIsEstimate: eta.estimate, etaReasons: eta.reasons } : {}),
      stages: stages.map((stage) => ({
        id: stage.id, stageIndex: stage.stageIndex, role: stage.role, agentRoleId: stage.agentRoleId,
        status: stage.status, startedAt: stage.startedAt, finishedAt: stage.finishedAt, errorMessage: stage.errorMessage,
        ...(includePayloads ? { input: stage.input, output: stage.output } : {}),
      })),
      logs: logs.map((log) => ({ id: log.id, stageExecutionId: log.stageExecutionId, level: log.level, message: log.message, meta: log.meta, createdAt: log.createdAt })),
      logsCursor: logPage.nextCursor,
      logsEarlierCursor: logPage.earlierCursor,
      logsHasEarlier: logPage.hasEarlier,
      logsHasMore: logPage.hasMore,
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

/**
 * Everything needed to write a `PipelineSpec.spec` in one call. Without it an agent has to guess the
 * shape from a rejection, which is what made "create a pipeline" fail repeatedly: the schema lives
 * in a file on the server, and neither the MCP catalogue nor Adminizer's model listing showed it.
 */
const pipelineSpecSchemaTool: IMcpTool = {
  name: 'agentiz.pipelineSpecSchema', group: 'agentiz',
  shortDescription: 'Returns the JSON Schema, rules and examples for the PipelineSpec.spec document.',
  description: 'Returns the exact shape of PipelineSpec.spec: the JSON Schema, the cross-field rules the schema cannot express, and ready examples. Pass projectId to also get the agentRoleKey values and the worker workspaces that project can actually reference. Call this before creating or updating a pipeline spec.',
  mode: 'protected',
  inputSchema: { type: 'object', properties: { projectId: { type: 'string', description: 'Fills in the role keys and workspaces available to this project.' } } },
  async handler(params) {
    const payload = objectParams(params);
    const projectId = stringParam(payload, 'projectId');

    const examples = {
      repository: {
        stages: [{ order: 1, role: 'implement', agentRoleKey: '<AgentRole.key>', model: '<optional, e.g. claude-opus-5 — overrides the role\'s own model for this stage only>', runtime: { mode: 'host' } }],
        finalAction: { type: 'commit_and_pr', branchPrefix: 'agentiz/' },
      },
      workerWorkspace: {
        source: { kind: 'worker_workspace', workspace: { workerId: '<AgentWorker.id>', workspaceKey: '<key from that worker\'s Workspaces>' } },
        stages: [{ order: 1, role: 'implement', agentRoleKey: '<AgentRole.key>', runtime: { mode: 'host' } }],
        finalAction: { type: 'comment_only' },
      },
      workerWorkspacePath: {
        source: { kind: 'worker_workspace', workspace: { workerId: '<AgentWorker.id>', path: '/absolute/path/on/that/worker', createIfMissing: true } },
        stages: [{ order: 1, role: 'implement', agentRoleKey: '<AgentRole.key>', runtime: { mode: 'host' } }],
        finalAction: { type: 'comment_only' },
      },
      workerWorkspaceGit: {
        source: {
          kind: 'worker_workspace',
          // Optional: omit it and the push goes through the remote configured in that checkout.
          repositoryId: '<optional AgentRepository.id linked to this project, to also verify the checkout\'s remote>',
          workspace: { workerId: '<AgentWorker.id>', path: '<absolute path covered by that worker\'s gitPushRoots; a declared workspaceKey works too>' },
        },
        stages: [{ order: 1, role: 'implement', agentRoleKey: '<AgentRole.key>', runtime: { mode: 'host' } }],
        finalAction: {
          type: 'commit', requireApproval: true,
          targetBranch: { mode: 'new', prefix: 'agentiz/' },
          commitMessageTemplate: '{{title}}\n\n{{summary}}',
        },
      },
    };

    const base = {
      storedIn: 'PipelineSpec.spec — a JSON object, not a JSON string. Create the row with agentiz.manage {entity:"pipelineSpec", operation:"create", values:{projectId, name, isDefault, spec}}.',
      schema: pipelineSpecSchema,
      rules: PIPELINE_SPEC_RULES,
      examples,
    };
    if (!projectId) return base;

    const [roles, workers] = await Promise.all([
      AgentRole.findAll({ where: { projectId }, order: [['key', 'ASC']] }),
      AgentWorker.findAll({ order: [['name', 'ASC']] }),
    ]);
    // A workspace is only reachable if the worker may claim this project's jobs and still exists.
    const usable = workers.filter((worker) => worker.status !== 'revoked' && worker.canClaimProject(projectId));
    const workspaces = usable.flatMap((worker) => (worker.workspaces ?? [])
      // A directory bound to another project is not offered at all: a spec naming it is refused on
      // save, so listing it here would only produce a rejection the caller cannot act on.
      .filter((workspace) => !workspace.projectId || workspace.projectId === projectId)
      .map((workspace) => ({
        workerId: worker.id, workerName: worker.name, workerStatus: worker.status,
        workerContactState: worker.contactState(), workspaceKey: workspace.key,
        path: workspace.path, label: workspace.label ?? null,
        projectId: workspace.projectId ?? null,
        git: worker.gitPushGrant(workspace.path, workspace),
      })));
    // Where a spec may point a `path` workspace and still be able to commit from it.
    const gitPushRoots = usable
      .filter((worker) => worker.gitPushRoots?.length)
      .map((worker) => ({ workerId: worker.id, workerName: worker.name, roots: worker.gitPushRoots }));
    return {
      ...base,
      project: {
        projectId,
        agentRoleKeys: roles.map((role) => role.key),
        workspaces,
        gitPushRoots,
        workersWithoutWorkspaces: usable.filter((worker) => !(worker.workspaces ?? []).length).map((worker) => ({ id: worker.id, name: worker.name, status: worker.status })),
        // A directory needs no declaration at all — `source.workspace.path` is enough. Said here
        // because an empty `workspaces` list otherwise looks like "this pipeline is impossible".
        namingADirectory: 'source.workspace.path takes any absolute path on that worker, with no declaration anywhere. A declared key (agentiz.manageWorker {operation:"setWorkspaces", workerId, workspaces:[{key:"<key>", path:"/absolute/path"}]}) is for when the path should be correctable without touching every spec; that call replaces the worker\'s whole list, so include existing entries.',
        // The one thing a spec genuinely cannot grant itself.
        allowingPush: 'finalAction "commit" needs exactly one thing beyond the spec: the worker must allow push from that directory — agentiz.manageWorker {operation:"setGitPushRoots", workerId, gitPushRoots:["/srv/projects"]} covers every directory below a prefix. It lives on the worker because the directory holds that machine\'s Git credentials. A declared workspace\'s git:{pushEnabled:true,remote:"upstream"} is the alternative and the only way to push to a remote other than "origin". No AgentRepository record is required: the push follows the remote configured in that checkout.',
      },
    };
  },
};

const capacityTool: IMcpTool = {
  name: 'agentiz.capacity', group: 'agentiz',
  shortDescription: 'Subscriptions, harness gates per worker and the top waiting jobs with ETA.',
  description: 'One call for "why is nothing running and when will it run": every harness subscription with its limit windows and exhaustedUntil, every worker\'s gated harness keys, concurrency and active hours, and the longest-waiting queued/released jobs with their next-eligible ETA.',
  mode: 'protected',
  inputSchema: { type: 'object', properties: {} },
  async handler() {
    return capacityOverview();
  },
};

const capacityHistoryTool: IMcpTool = {
  name: 'agentiz.capacityHistory', group: 'agentiz',
  shortDescription: 'Usage-sample series per worker × harness: normalized windows plus provider meta.',
  description: 'Returns AgentHarnessUsageSample rows (usage telemetry history) filtered by workerId, subscriptionId, harnessKey and a time range. windows is the abstract normalized part; meta is the provider layer\'s own opaque detail, returned as stored — analysis of it belongs to that layer, not the core.',
  mode: 'protected',
  inputSchema: {
    type: 'object',
    properties: {
      workerId: { type: 'string' }, subscriptionId: { type: 'string' }, harnessKey: { type: 'string' },
      from: { type: 'string', description: 'ISO date; only samples observed at/after it.' },
      to: { type: 'string', description: 'ISO date; only samples observed at/before it.' },
      limit: { type: 'integer', default: 500, maximum: 2000 },
    },
  },
  async handler(params) {
    const payload = objectParams(params);
    const from = stringParam(payload, 'from');
    const to = stringParam(payload, 'to');
    const items = await usageHistory({
      workerId: stringParam(payload, 'workerId'),
      subscriptionId: stringParam(payload, 'subscriptionId'),
      harnessKey: stringParam(payload, 'harnessKey'),
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: typeof payload.limit === 'number' ? payload.limit : undefined,
    });
    return { count: items.length, items };
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
  description: 'Creates a pipeline run for taskId and queues a worker job. Optionally provide workerId and executorKey together to select an administrator-configured worker executor (for example Codex); that pins the job to that worker. model overrides the model of every stage for this run only, and reasoningLevel (low|medium|high|xhigh) sets how hard the agent thinks; both leave the pipeline untouched when omitted. Completion may create commits, pull requests or tracker comments according to the selected pipeline specification.',
  mode: 'protected',
  inputSchema: {
    type: 'object',
    required: ['taskId'],
    properties: {
      taskId: { type: 'string' },
      workerId: { type: 'string' },
      executorKey: { type: 'string' },
      model: { type: 'string' },
      reasoningLevel: { type: 'string', enum: REASONING_LEVELS },
    },
  },
  async handler(params) {
    const payload = objectParams(params);
    const taskId = stringParam(payload, 'taskId');
    if (!taskId) throw new Error('taskId:string is required');
    const executorOverride = normalizeRunOverride(payload);
    return runTeaser(await AgentPipelineService.runTask(taskId, 'manual', { executorOverride }));
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

export const agentizMcpTools: IMcpTool[] = [
  overviewTool, projectsTool, tasksTool, runsTool, runDetailsTool, configurationTool,
  pipelineSpecSchemaTool, workersTool, workerDetailsTool, jobsTool,
  capacityTool, capacityHistoryTool,
  syncTool, runTaskTool, cancelRunTool, manageBusinessDataTool, manageWorkerTool,
  ...agentizProposalMcpTools,
  ...agentizCapacityActionTools,
  ...notificationPolicyMcpTools,
  ...agentizWorkflowMcpTools,
];
