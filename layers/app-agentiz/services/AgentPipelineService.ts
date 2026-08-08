import { AgentProject } from '../models/AgentProject';
import { AgentRole } from '../models/AgentRole';
import { AgentRun } from '../models/AgentRun';
import { AgentRunLog } from '../models/AgentRunLog';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentStageExecution } from '../models/AgentStageExecution';
import { AgentTask } from '../models/AgentTask';
import { AgentTaskComment } from '../models/AgentTaskComment';
import { AgentWorker } from '../models/AgentWorker';
import { AgentRunDiff } from '../models/AgentRunDiff';
import { AgentGitConnection } from '../models/AgentGitConnection';
import { AgentProjectRepository } from '../models/AgentProjectRepository';
import { AgentRepository } from '../models/AgentRepository';
import { RepositoryResolverService } from './RepositoryResolverService';
import { branchFromTags, createGitProviderForTask, mergeFileOps, normalizeFileChanges, resolveTaskRepository } from '../lib/git';
import type { FileChange, FileOp } from '../lib/git';
import { DEFAULT_HOOK_TIMEOUT_SEC, MAX_HOOK_TIMEOUT_SEC, buildHookEnv } from '../lib/hookEnv';
import { hasUpstreamThread } from '../lib/taskManager';
import { assertValidSpec, isWorkspaceSource, orderedStages, resolveSpecForTask } from './PipelineSpecResolver';
import { resolveAgentExecutor } from './agents';
import type { AgentStageResult } from './agents';
import type {
  AgentRunTrigger,
  AgentTaskStatus,
  PipelineFinalActionDef,
  PipelineHookDef,
  PipelineSpecDef,
  PipelineWorkerWorkspaceDef,
} from '../types/agentiz';

export interface RunConversationTurn {
  id: string;
  authorKind: string;
  authorName: string | null;
  body: string;
  createdAt: Date;
  runId: string | null;
}

/**
 * The directory a `worker_workspace` run executes in, resolved from the pipeline's
 * `source.workspace` at queue time. The path is resolved here rather than stored in the spec so
 * that correcting a path on the worker record fixes every pipeline pointing at it.
 */
export interface RunWorkspaceRef {
  workerId: string;
  workerName: string;
  /** null when the spec named the directory with `path` instead of a declared `workspaceKey`. */
  key: string | null;
  path: string;
  label: string | null;
  /** Create `path` if it does not exist yet, instead of failing. Only ever true for a `path`-named workspace. */
  createIfMissing: boolean;
}

export interface RunConversation {
  /** The new user message that should be treated as the main instruction. */
  primaryPrompt: RunConversationTurn | null;
  /** Complete task discussion available when the run was queued, oldest first. */
  messages: RunConversationTurn[];
  /** Results of earlier runs, including stage outputs when they exist. */
  priorRuns: Array<Record<string, unknown>>;
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => values[key] ?? '');
}

async function writeLog(
  runId: string,
  projectId: string | null,
  stageExecutionId: string | null,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  await AgentRunLog.create({ runId, projectId, stageExecutionId, level, message, meta: meta ?? null });
}

export class AgentPipelineService {
  /**
   * Creates a run for a task: resolves which spec applies, freezes it into the run, and
   * pre-creates one pending AgentStageExecution per stage. Nothing is executed yet.
   */
  static async createRun(
    taskId: string,
    trigger: AgentRunTrigger = 'manual',
    options: { triggerCommentId?: string | null } = {},
  ): Promise<AgentRun> {
    const task = await AgentTask.findByPk(taskId);
    if (!task) throw new Error(`AgentTask ${taskId} not found`);

    const spec = await resolveSpecForTask(task);
    const snapshot = spec.spec as PipelineSpecDef;
    assertValidSpec(snapshot);

    const [previousRun, latestHumanComment] = await Promise.all([
      AgentRun.findOne({ where: { taskId: task.id }, order: [['createdAt', 'DESC']] }),
      // A manually started run after a conversation still continues that conversation.  This
      // covers projects where the event trigger is disabled or was enabled only later.
      trigger === 'manual' && options.triggerCommentId === undefined
        ? AgentTaskComment.findOne({ where: { taskId: task.id, authorKind: 'human' }, order: [['createdAt', 'DESC']] })
        : Promise.resolve(null),
    ]);
    const triggerCommentId = options.triggerCommentId ?? latestHumanComment?.id ?? null;
    const run = await AgentRun.create({
      taskId: task.id,
      projectId: task.projectId,
      status: 'pending',
      trigger,
      triggerCommentId,
      previousRunId: previousRun?.id ?? null,
      pipelineSnapshot: snapshot,
      currentStageIndex: 0,
    });

    const stages = orderedStages(snapshot);
    for (const [index, stage] of stages.entries()) {
      const role = await AgentRole.findOne({ where: { projectId: task.projectId, key: stage.agentRoleKey } });
      await AgentStageExecution.create({
        runId: run.id,
        stageIndex: index,
        role: stage.role,
        agentRoleId: role?.id ?? null,
        status: 'pending',
        input: { stage: stage as unknown as Record<string, unknown> },
      });
    }

    await task.update({ status: 'queued', pipelineSpecId: spec.id });
    await writeLog(run.id, run.projectId, null, 'info', `Run created from spec "${spec.name}" with ${stages.length} stage(s)`, {
      specId: spec.id,
      trigger,
    });

    return run;
  }

  /**
   * Executes every stage of the run in order, then performs the spec's final action.
   * File changes proposed by the stages are accumulated (later stages win on the same path) and
   * pushed as one commit — this is the "в конце она делает коммит, который улетает обратно
   * в git репозиторий" step.
   */
  static async executeRun(runId: string): Promise<AgentRun> {
    const run = await AgentRun.findByPk(runId);
    if (!run) throw new Error(`AgentRun ${runId} not found`);
    if (run.status === 'running') throw new Error(`AgentRun ${runId} is already running`);

    const task = await AgentTask.findByPk(run.taskId);
    const project = await AgentProject.findByPk(run.projectId);
    if (!task || !project) throw new Error(`AgentRun ${runId}: task or project is missing`);
    const job = await AgentRunJob.findOne({ where: { runId: run.id } });
    // The queue payload is the causal boundary. Local and external workers must see the same
    // conversation even if somebody writes another message while this run is waiting to start.
    const conversation = (job?.snapshot?.conversation as RunConversation | undefined)
      ?? await AgentWorkerJobBuilder.conversationForRun(run);

    await run.update({ status: 'running', startedAt: new Date() });
    await task.update({ status: 'running' });

    const stages = orderedStages(run.pipelineSnapshot);
    const previousOutputs: Record<string, AgentStageResult> = {};
    // An ordered list, not a per-path map: delete after upsert collapses, and a rename touches two
    // paths at once, so sequence carries information a map would throw away.
    let fileOps: FileOp[] = [];
    let failed = false;
    let failureMessage: string | null = null;

    for (const [index, stage] of stages.entries()) {
      const execution = await AgentStageExecution.findOne({ where: { runId: run.id, stageIndex: index } });
      if (!execution) continue;

      if (failed) {
        await execution.update({ status: 'skipped', finishedAt: new Date() });
        await writeLog(run.id, run.projectId, execution.id, 'warn', `Stage ${stage.order} (${stage.role}) skipped after earlier failure`);
        continue;
      }

      await run.update({ currentStageIndex: index });
      await execution.update({ status: 'running', startedAt: new Date() });

      try {
        const role = await AgentRole.findOne({ where: { projectId: project.id, key: stage.agentRoleKey } });
        if (!role) {
          throw new Error(`Agent role "${stage.agentRoleKey}" not found in project ${project.slug}`);
        }

        const executor = resolveAgentExecutor(role);
        const result = await executor.execute({
          project,
          task,
          run,
          stage,
          role,
          previousOutputs,
          conversation,
          log: (level, message, meta) => writeLog(run.id, run.projectId, execution.id, level, message, meta),
        });

        previousOutputs[stage.role] = result;
        fileOps = mergeFileOps(fileOps, normalizeFileChanges(result.fileChanges));

        await execution.update({
          status: 'succeeded',
          output: { ...result.output, summary: result.summary },
          finishedAt: new Date(),
        });
        await writeLog(run.id, run.projectId, execution.id, 'info', `Stage ${stage.order} (${stage.role}) succeeded: ${result.summary}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await execution.update({ status: 'failed', errorMessage: message, finishedAt: new Date() });
        await writeLog(run.id, run.projectId, execution.id, 'error', `Stage ${stage.order} (${stage.role}) failed: ${message}`);
        if ((stage.onFail ?? 'stop') === 'stop') {
          failed = true;
          failureMessage = `Stage ${stage.order} (${stage.role}) failed: ${message}`;
        }
      }
    }

    const summaryLines = Object.entries(previousOutputs).map(([role, result]) => `- ${role}: ${result.summary}`);
    const summary = summaryLines.join('\n');

    if (failed) {
      await run.update({
        status: 'failed',
        finishedAt: new Date(),
        resultSummary: summary || null,
        errorMessage: failureMessage,
      });
      await task.update({ status: 'failed' });
      await writeLog(run.id, run.projectId, null, 'error', `Run failed: ${failureMessage}`);
      return run;
    }

    try {
      await this.applyFinalAction({
        run,
        task,
        project,
        changes: fileOps,
        summary,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await run.update({ status: 'failed', finishedAt: new Date(), resultSummary: summary || null, errorMessage: message });
      await task.update({ status: 'failed' });
      await writeLog(run.id, run.projectId, null, 'error', `Final action failed: ${message}`);
      return run;
    }

    await run.update({ status: 'succeeded', finishedAt: new Date(), resultSummary: summary || null, errorMessage: null });
    const finalTaskStatus: AgentTaskStatus = this.taskStatusAfter(run.pipelineSnapshot.finalAction);
    await task.update({ status: finalTaskStatus });
    await writeLog(run.id, run.projectId, null, 'info', `Run succeeded, task moved to "${finalTaskStatus}"`);

    return run;
  }

  /** Creates the run and queues exactly one durable worker job. Execution happens out of request. */
  static async runTask(
    taskId: string,
    trigger: AgentRunTrigger = 'manual',
    options: { triggerCommentId?: string | null } = {},
  ): Promise<AgentRun> {
    const run = await this.createRun(taskId, trigger, options);
    try {
      await AgentWorkerJobBuilder.enqueueRun(run);
    } catch (error) {
      // Building the payload resolves the repository or the worker directory, so it fails on a
      // misconfiguration. Without this the run would stay `pending` and the task `queued` forever,
      // with the real reason visible only to whoever made the request.
      const message = error instanceof Error ? error.message : String(error);
      await run.update({ status: 'failed', finishedAt: new Date(), errorMessage: message });
      await AgentTask.update({ status: 'failed' }, { where: { id: run.taskId } });
      await writeLog(run.id, run.projectId, null, 'error', `Run could not be queued: ${message}`);
      throw error;
    }
    return run;
  }

  /** Starts the matching pipeline for a newly written human message when that event is enabled. */
  static async runForHumanComment(taskId: string, commentId: string): Promise<AgentRun | null> {
    const task = await AgentTask.findByPk(taskId);
    if (!task) throw new Error(`AgentTask ${taskId} not found`);
    const spec = await resolveSpecForTask(task);
    if (spec.spec.triggers?.humanComment !== true) return null;
    return this.runTask(taskId, 'human_comment', { triggerCommentId: commentId });
  }

  /**
   * Writes the run's outcome into the task's comment thread as an `agent` comment.
   *
   * Called for successful runs (from applyFinalAction) and for failed/cancelled ones (from
   * AgentWorkerApiService.applyResult) — a failure is precisely what a person needs to read in the
   * tracker, so it must not be the case that only successes leave a trace.
   *
   * Deliberately best-effort: a comment must never be the reason a finished run is recorded as
   * failed, so a write error only lands in the run log.
   */
  static async reportToTaskThread(run: AgentRun, task: AgentTask, summary: string): Promise<void> {
    try {
      await AgentTaskComment.create({
        taskId: task.id,
        authorKind: 'agent',
        authorName: `run ${run.id.slice(0, 8)}`,
        authorId: null,
        runId: run.id,
        body: summary || 'Запуск завершён без текстового результата.',
        externalId: null,
        externalUrl: null,
        meta: { kind: 'run.finished', runId: run.id, runStatus: run.status },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeLog(run.id, run.projectId, null, 'warn', `Could not add the agent comment to the task: ${message}`);
    }
  }

  /**
   * Where the task ends up once the run succeeded.
   *
   * `waiting_review` means a person still has to look: either a PR is open upstream, or the change
   * is held in Agentiz by `requireApproval` and nothing has been pushed at all.
   */
  static taskStatusAfter(action: PipelineFinalActionDef): AgentTaskStatus {
    if (action.requireApproval && (action.type === 'commit' || action.type === 'commit_and_pr')) return 'waiting_review';
    return action.type === 'commit_and_pr' ? 'waiting_review' : 'done';
  }

  static async applyFinalAction(params: {
    run: AgentRun;
    task: AgentTask;
    project: AgentProject;
    changes: Array<FileChange | FileOp>;
    summary: string;
    /** Stored diff, when the caller already wrote one; used to hold the change back. */
    diff?: AgentRunDiff | null;
  }): Promise<void> {
    const { run, task, project, summary, diff } = params;
    const changes = normalizeFileChanges(params.changes);
    const action = run.pipelineSnapshot.finalAction;
    const templateValues = {
      taskId: task.id,
      externalId: task.externalId,
      title: task.title,
      summary,
    };

    // The run always reports into the local task thread, whatever it does upstream: the built-in
    // tracker is where a person reads what the machine did, and it must work even for a project
    // with no reachable external system at all.
    await this.reportToTaskThread(run, task, summary);

    if (action.type === 'none') {
      await writeLog(run.id, run.projectId, null, 'info', 'Final action: none, nothing pushed back');
      return;
    }

    if (action.type === 'comment_only') {
      // A task created in Agentiz has no upstream thread, and a pipeline that works in a worker
      // directory is routinely exactly that: a local task, a prepared directory, no git provider
      // anywhere. reportToTaskThread above already delivered the summary to the only place it can
      // go, so the action is done — failing here would fail a run whose every stage succeeded.
      if (!hasUpstreamThread(task.sourceType)) {
        await writeLog(run.id, run.projectId, null, 'info',
          'Final action: comment_only, reported in the local task thread — this task has no external tracker');
        return;
      }
      // Deliberately the *task's* provider, not the run's code repository: a comment belongs where
      // the task lives, and those are not always the same place.
      const provider = await createGitProviderForTask(task, project);
      const body = `Agentiz run \`${run.id}\` finished.\n\n${summary}`;
      const comment = await provider.commentOnTask(task.externalId, body);
      await run.update({ responseUrl: comment.url });
      await writeLog(run.id, run.projectId, null, 'info', `Final action: commented on task, ${comment.url}`);
      return;
    }

    if (changes.length === 0) {
      throw new Error(`Final action ${action.type} requested but no stage produced file changes`);
    }

    // Nothing reaches the repository: the diff is already stored, and somebody applies it later
    // through applyStoredDiff. Not an error — this is what the pipeline was configured to do.
    if (action.requireApproval) {
      await writeLog(run.id, run.projectId, null, 'info',
        `Final action: ${action.type} held for approval, ${changes.length} operation(s) waiting in Agentiz`,
        { diffId: diff?.id ?? null });
      return;
    }

    await this.pushChanges({ run, task, project, action, changes, summary, templateValues, diff: diff ?? null });
  }

  /**
   * Commits the operations and, for `commit_and_pr`, opens the pull request.
   *
   * Shared by the automatic path and by `applyStoredDiff`, so an approved change goes through
   * exactly the same code as an unattended one.
   */
  private static async pushChanges(params: {
    run: AgentRun;
    task: AgentTask;
    project: AgentProject;
    action: PipelineFinalActionDef;
    changes: FileOp[];
    summary: string;
    templateValues: Record<string, string>;
    diff: AgentRunDiff | null;
  }): Promise<void> {
    const { run, task, project, action, changes, summary, templateValues, diff } = params;
    // The repository the code was taken from — the commit goes back into it, not into whichever
    // repository the task happened to arrive from.
    const provider = await this.providerForRunCode(run, task, project);
    const baseBranch = run.baseRef ?? project.repoConfig?.defaultBranch;

    // `commit` pushes onto the target branch itself; `commit_and_pr` keeps the work on its own
    // branch so the pull request has something to compare against.
    const branch = action.type === 'commit'
      ? (action.branch?.trim() || baseBranch || 'main')
      : `${action.branchPrefix ?? 'agentiz/'}${task.externalId}`;

    const message = renderTemplate(
      action.commitMessageTemplate ?? 'agentiz: {{title}} (#{{externalId}})',
      templateValues,
    );

    const commit = await provider.commitChanges({ branch, baseBranch, message, changes });
    await run.update({ commitSha: commit.sha, commitUrl: commit.url });
    if (diff) await diff.update({ appliedAt: new Date(), appliedCommitSha: commit.sha });
    await writeLog(run.id, run.projectId, null, 'info', `Committed ${changes.length} operation(s) to ${branch}: ${commit.url}`);

    if (action.type === 'commit') return;

    const pr = await provider.openPullRequest({
      branch,
      baseBranch,
      title: renderTemplate(action.pullRequestTitleTemplate ?? 'agentiz: {{title}}', templateValues),
      body: `Automated by agentiz run \`${run.id}\` for task #${task.externalId}.\n\n${summary}`,
    });
    await run.update({ responseUrl: pr.url });
    await writeLog(run.id, run.projectId, null, 'info', `Opened pull request ${pr.url}`);
  }

  /**
   * Pushes a diff that `requireApproval` held back.
   *
   * Refuses a second application rather than producing a second commit: the panel button is easy to
   * press twice, and `appliedAt` is the only thing standing between that and a duplicate.
   */
  static async applyStoredDiff(runId: string, actor = 'admin'): Promise<AgentRunDiff> {
    const diff = await AgentRunDiff.findOne({ where: { runId } });
    if (!diff) throw new Error(`Run ${runId} has no stored diff`);
    if (diff.appliedAt) {
      throw new Error(`Run ${runId} was already applied at ${diff.appliedAt.toISOString()} (commit ${diff.appliedCommitSha ?? 'unknown'})`);
    }

    const run = await AgentRun.findByPk(runId);
    if (!run) throw new Error(`AgentRun ${runId} not found`);
    const [task, project] = await Promise.all([AgentTask.findByPk(run.taskId), AgentProject.findByPk(run.projectId)]);
    if (!task || !project) throw new Error(`AgentRun ${runId}: task or project is missing`);

    const action = run.pipelineSnapshot.finalAction;
    const changes = normalizeFileChanges(diff.ops ?? []);
    if (changes.length === 0) throw new Error(`Run ${runId} stored no file operations to apply`);

    await this.pushChanges({
      run,
      task,
      project,
      action,
      changes,
      summary: run.resultSummary ?? '',
      templateValues: { taskId: task.id, externalId: task.externalId, title: task.title, summary: run.resultSummary ?? '' },
      diff,
    });

    await task.update({ status: action.type === 'commit_and_pr' ? 'waiting_review' : 'done' });
    await writeLog(run.id, run.projectId, null, 'info', `Stored diff applied by ${actor}`, { diffId: diff.id });
    return diff;
  }

  /**
   * The repository this pipeline pinned, if it pinned one.
   *
   * Only a repository already linked to the same project is accepted: a pipeline naming an
   * arbitrary `AgentRepository.id` must not become a way to reach a repository the project was
   * never given.
   */
  static async pinnedRepository(
    spec: PipelineSpecDef,
    project: AgentProject,
  ): Promise<{ repository: AgentRepository; connection: AgentGitConnection; link: AgentProjectRepository } | null> {
    const repositoryId = spec.source?.repositoryId?.trim();
    if (!repositoryId || isWorkspaceSource(spec.source)) return null;

    const link = await AgentProjectRepository.findOne({
      where: { projectId: project.id, repositoryId, isActive: true },
    });
    if (!link) {
      throw new Error(
        `Pipeline points at repository ${repositoryId}, which is not linked to project ${project.slug} (or the link is disabled)`,
      );
    }
    const [repository, connection] = await Promise.all([
      AgentRepository.findByPk(link.repositoryId),
      AgentGitConnection.findByPk(link.connectionId),
    ]);
    if (!repository || !connection) {
      throw new Error(`Pipeline repository ${repositoryId} has lost its repository or connection row`);
    }
    return { repository, connection, link };
  }

  /**
   * The provider the run's **code** goes through — for checkout and for the commit alike.
   *
   * One repository per run, used at both ends: the code is committed back where it was taken from.
   * Note that this is not always the same provider as the task's — a task can arrive from one
   * place while the code being changed lives in another, which is exactly what pinning is for.
   * Comments go to the task's provider, not to this one.
   */
  static async providerForRunCode(run: AgentRun, task: AgentTask, project: AgentProject) {
    const pinned = await this.pinnedRepository(run.pipelineSnapshot, project);
    if (!pinned) return createGitProviderForTask(task, project);
    return RepositoryResolverService.providerFor(
      pinned.repository,
      pinned.connection,
      run.baseRef ?? pinned.link.config?.defaultBranch,
    );
  }

  static async cancelRun(runId: string, reason = 'Cancelled by user'): Promise<AgentRun> {
    const run = await AgentRun.findByPk(runId);
    if (!run) throw new Error(`AgentRun ${runId} not found`);
    if (run.status === 'succeeded' || run.status === 'failed') {
      throw new Error(`AgentRun ${runId} already finished with status ${run.status}`);
    }
    const job = await AgentRunJob.findOne({ where: { runId } });
    if (job && (job.status === 'queued' || job.status === 'released')) {
      await job.update({ status: 'cancelled', cancelRequestedAt: new Date(), cancelReason: reason });
      await run.update({ status: 'cancelled', finishedAt: new Date(), errorMessage: reason });
      await AgentTask.update({ status: 'cancelled' }, { where: { id: run.taskId } });
      await writeLog(run.id, run.projectId, null, 'warn', `Queued run cancelled: ${reason}`);
      return run;
    }
    if (job && (job.status === 'leased' || job.status === 'running')) {
      await job.update({ cancelRequestedAt: new Date(), cancelReason: reason });
      await writeLog(run.id, run.projectId, null, 'warn', `Cancel requested for worker job: ${reason}`);
      return run;
    }
    await run.update({ status: 'cancelled', finishedAt: new Date(), errorMessage: reason });
    await AgentTask.update({ status: 'cancelled' }, { where: { id: run.taskId } });
    await writeLog(run.id, run.projectId, null, 'warn', `Run cancelled: ${reason}`);
    return run;
  }

  static async log(
    runId: string,
    projectId: string | null,
    stageExecutionId: string | null,
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    await writeLog(runId, projectId, stageExecutionId, level, message, meta);
  }
}

export class AgentWorkerJobBuilder {
  static async enqueueRun(run: AgentRun): Promise<AgentRunJob> {
    const snapshot = await this.buildSnapshot(run);
    // Only the machine holding the directory can run such a job, so the restriction is recorded on
    // the job itself and enforced by every claim query rather than checked after the fact.
    const workspace = snapshot.workspace as RunWorkspaceRef | null;
    const requiredWorkerId = workspace?.workerId ?? null;
    // Mirrored out of the snapshot for the same reason: the claim query has to filter on it in SQL.
    const repositoryId = (snapshot.repository as { repositoryId?: string } | null)?.repositoryId ?? null;
    const [job, created] = await AgentRunJob.findOrCreate({
      where: { runId: run.id },
      defaults: {
        runId: run.id,
        projectId: run.projectId,
        status: 'queued',
        priority: 100,
        attempt: 0,
        workerId: null,
        repositoryId,
        requiredWorkerId,
        leaseTokenHash: null,
        lockedUntil: null,
        availableAt: new Date(),
        cancelRequestedAt: null,
        cancelReason: null,
        snapshot,
        result: null,
        lastError: null,
      },
    });
    if (!created && job.status === 'released') {
      await job.update({ status: 'queued', availableAt: new Date(), snapshot, repositoryId, requiredWorkerId });
    }
    if (created) {
      await writeLog(run.id, run.projectId, null, 'info', 'Worker job queued', {
        jobId: job.id,
        ...(workspace ? { workerId: workspace.workerId, workspace: workspace.key, path: workspace.path } : {}),
      });
    }
    return job;
  }

  static async buildSnapshot(run: AgentRun): Promise<Record<string, unknown>> {
    const [task, project] = await Promise.all([
      AgentTask.findByPk(run.taskId),
      AgentProject.findByPk(run.projectId),
    ]);
    if (!task || !project) throw new Error(`AgentRun ${run.id}: task or project is missing`);

    const conversation = await this.conversationForRun(run);
    const stages = await Promise.all(orderedStages(run.pipelineSnapshot).map(async (stage, index) => {
      const role = await AgentRole.findOne({ where: { projectId: project.id, key: stage.agentRoleKey } });
      const execution = await AgentStageExecution.findOne({ where: { runId: run.id, stageIndex: index } });
      return {
        executionId: execution?.id ?? null,
        stageIndex: index,
        order: stage.order,
        role: stage.role,
        agentRoleKey: stage.agentRoleKey,
        onFail: stage.onFail,
        runtime: stage.runtime ?? null,
        systemPrompt: role?.systemPrompt ?? null,
        agent: {
          kind: String((role?.config as any)?.executor ?? 'stub'),
          model: role?.model ?? null,
          allowedTools: role?.allowedTools ?? [],
          config: role?.config ?? {},
        },
      };
    }));

    // A pipeline whose source is a worker directory has no hosted repository by definition: the
    // environment already exists on that machine, so nothing is resolved through a git provider.
    const source = run.pipelineSnapshot.source;
    const workspace = isWorkspaceSource(source)
      ? await this.resolveWorkspace(source!.workspace as PipelineWorkerWorkspaceDef)
      : null;

    // finalAction 'none' never touches git (see finalize()), so a task-manager-only project with
    // no repository at all — neither its own repoConfig nor an integration — must still be able to
    // queue a job instead of failing before the first stage even runs.
    const finalAction = run.pipelineSnapshot.finalAction;
    let repository: Record<string, unknown> | null = null;
    if (!workspace && finalAction.type !== 'none') {
      // The pipeline's own repository wins when it names one; otherwise the task decides, as before.
      const pinned = await AgentPipelineService.pinnedRepository(run.pipelineSnapshot, project);
      const resolved = pinned
        ? {
            provider: pinned.repository.provider,
            baseUrl: pinned.connection.baseUrl ?? undefined,
            owner: pinned.repository.owner,
            repo: pinned.repository.repo,
            defaultBranch: pinned.link.config?.defaultBranch ?? pinned.repository.defaultBranch ?? undefined,
            repositoryId: pinned.repository.id,
            cloneUrl: pinned.repository.cloneUrl ?? undefined,
          }
        : await resolveTaskRepository(task, project);
      const baseHost = resolved.baseUrl
        ? resolved.baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
        : resolved.provider === 'gitlab' ? 'gitlab.com' : 'github.com';
      const baseRef = this.resolveBaseRef(task, run.pipelineSnapshot, resolved.defaultBranch);
      const baseSha = await this.resolveBaseSha(run, task, project, baseRef, resolved);
      // Recorded on the run so the final action does not resolve the branch a second time, and so
      // the run card can show which commit the work started from.
      await run.update({ baseRef, baseSha });
      repository = {
        repositoryId: resolved.repositoryId ?? null,
        provider: resolved.provider,
        // The platform's own clone URL when the repository came from a connection; assembled from
        // the host only for a project's plain repoConfig, which carries no URL of its own.
        cloneUrl: resolved.cloneUrl ?? `https://${baseHost}/${resolved.owner}/${resolved.repo}.git`,
        owner: resolved.owner,
        repo: resolved.repo,
        baseRef,
        baseSha,
      };
    }
    return {
      schemaVersion: 1,
      runId: run.id,
      lineage: { triggerCommentId: run.triggerCommentId, previousRunId: run.previousRunId },
      repository,
      // Present only for a worker-directory pipeline; the worker runs every stage in `path`.
      workspace,
      task: {
        id: task.id,
        externalId: task.externalId,
        title: task.title,
        description: task.description ?? '',
        tags: task.tags ?? [],
        externalUrl: task.externalUrl,
      },
      conversation,
      stages,
      // Scripts to run around the stages, with their values already resolved. The worker exports
      // what it is given and adds only what it alone knows (the directory, which hook, the status).
      hooks: this.buildHooks(run, task, project, stages.length, repository, workspace),
      finalAction: run.pipelineSnapshot.finalAction,
      validation: { commands: [], timeoutSec: 1800 },
      limits: { jobTimeoutSec: 3600, maxOutputBytes: 10485760 },
    };
  }

  /**
   * The `hooks` block of the snapshot, or null when the pipeline declares none.
   *
   * The environment is computed once and shared by both hooks: they run in the same directory on
   * the same run, and a `before` that sees a different `AGENTIZ_BASE_SHA` than `after` would be a
   * bug waiting to be debugged at three in the morning.
   */
  private static buildHooks(
    run: AgentRun,
    task: AgentTask,
    project: AgentProject,
    stageCount: number,
    repository: Record<string, unknown> | null,
    workspace: RunWorkspaceRef | null,
  ): Record<string, unknown> | null {
    const hooks = run.pipelineSnapshot.hooks;
    if (!hooks?.before && !hooks?.after) return null;
    const describe = (hook: PipelineHookDef | undefined) => (hook
      ? {
          interpreter: hook.interpreter,
          script: hook.script,
          timeoutSec: Math.min(hook.timeoutSec ?? DEFAULT_HOOK_TIMEOUT_SEC, MAX_HOOK_TIMEOUT_SEC),
          onFail: hook.onFail ?? 'stop',
        }
      : null);
    return {
      env: buildHookEnv({ run, task, project, stageCount, repository, workspace }),
      before: describe(hooks.before),
      after: describe(hooks.after),
    };
  }

  /**
   * Which branch this run works on, most specific first:
   *
   *   1. `AgentTask.branchRef`      — a branch somebody set on the task itself;
   *   2. tag `branch:<ref>`         — a branch set in the tracker, where there is no such field;
   *   3. `spec.source.branch`       — the pipeline's default;
   *   4. the repository's own default branch;
   *   5. `main`.
   *
   * Steps 1 and 2 are skipped when `source.allowTaskOverride` is explicitly false — that is for a
   * project which must always build from one branch, whatever a task asks for.
   */
  static resolveBaseRef(task: AgentTask, spec: PipelineSpecDef, repositoryDefault?: string | null): string {
    const source = spec.source;
    if (source?.allowTaskOverride !== false) {
      const fromTask = task.branchRef?.trim();
      if (fromTask) return fromTask;
      const fromTag = branchFromTags(task.tags);
      if (fromTag) return fromTag;
    }
    return source?.branch?.trim() || repositoryDefault?.trim() || 'main';
  }

  /**
   * The commit that branch points at right now.
   *
   * A failure here stops the run before the job is queued. Queueing with `baseSha: null` and
   * letting the worker fail on checkout would surface the same mistake five minutes later, in
   * somebody else's context, with a worker-side message instead of "branch X not found in Y".
   */
  private static async resolveBaseSha(
    run: AgentRun,
    task: AgentTask,
    project: AgentProject,
    baseRef: string,
    repository: { owner: string; repo: string },
  ): Promise<string> {
    // Resolved in the repository the code actually comes from, which is not necessarily the task's.
    const provider = await AgentPipelineService.providerForRunCode(run, task, project);
    try {
      return (await provider.resolveRef(baseRef)).sha;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not resolve branch "${baseRef}" in ${repository.owner}/${repository.repo}: ${message}`);
    }
  }

  /**
   * Turns `source.workspace` into the concrete directory the worker will use.
   *
   * Every failure here is a configuration mistake an operator has to see by name — a job pinned to
   * a worker that no longer offers the directory would otherwise sit in the queue forever, because
   * no other worker is allowed to take it.
   *
   * With `path`, the spec names the directory itself and no lookup on the worker record happens —
   * the worker checks the path (and creates it, if `createIfMissing`) when it actually runs the
   * job, because this server does not have that machine's filesystem. With `workspaceKey`, the
   * directory must already be declared via `AgentWorkerRegistryService.setWorkspaces`.
   */
  static async resolveWorkspace(ref: PipelineWorkerWorkspaceDef): Promise<RunWorkspaceRef> {
    const worker = await AgentWorker.findByPk(ref.workerId);
    if (!worker) {
      throw new Error(`Pipeline runs in a worker directory, but worker ${ref.workerId} no longer exists`);
    }
    if (worker.status === 'revoked') {
      throw new Error(`Worker "${worker.name}" is revoked, so its directory cannot be used`);
    }
    if (ref.path) {
      return {
        workerId: worker.id,
        workerName: worker.name,
        key: null,
        path: ref.path.trim(),
        label: null,
        createIfMissing: !!ref.createIfMissing,
      };
    }
    const declared = worker.workspace(ref.workspaceKey!);
    if (!declared) {
      const known = (worker.workspaces ?? []).map((item) => item.key).join(', ') || 'none';
      throw new Error(`Worker "${worker.name}" has no directory "${ref.workspaceKey}" (declared: ${known})`);
    }
    if (!declared.path?.trim()) {
      throw new Error(`Directory "${ref.workspaceKey}" on worker "${worker.name}" has an empty path`);
    }
    return {
      workerId: worker.id,
      workerName: worker.name,
      key: declared.key,
      path: declared.path.trim(),
      label: declared.label ?? null,
      createIfMissing: false,
    };
  }

  /**
   * Freeze the complete thread and prior run results into the worker payload.  A run gets a
   * stable view at queue time: messages written later belong to a later run, not this one.
   */
  static async conversationForRun(run: AgentRun): Promise<RunConversation> {
    const [comments, priorRuns] = await Promise.all([
      AgentTaskComment.findAll({ where: { taskId: run.taskId }, order: [['createdAt', 'ASC']] }),
      AgentRun.findAll({
        where: { taskId: run.taskId },
        order: [['createdAt', 'ASC']],
      }),
    ]);
    const triggerComment = run.triggerCommentId
      ? comments.find((comment) => comment.id === run.triggerCommentId) ?? null
      : null;
    const cutoff = triggerComment
      ? new Date(triggerComment.externalCreatedAt ?? triggerComment.createdAt).getTime()
      : new Date(run.createdAt).getTime();
    const messages = comments
      .filter((comment) => new Date(comment.externalCreatedAt ?? comment.createdAt).getTime() <= cutoff)
      .sort((a, b) => new Date(a.externalCreatedAt ?? a.createdAt).getTime() - new Date(b.externalCreatedAt ?? b.createdAt).getTime())
      .map((comment) => ({
        id: comment.id,
        authorKind: comment.authorKind,
        authorName: comment.authorName,
        body: comment.body,
        createdAt: comment.externalCreatedAt ?? comment.createdAt,
        runId: comment.runId,
      }));
    const primaryPrompt = run.triggerCommentId
      ? messages.find((message) => message.id === run.triggerCommentId) ?? null
      : null;
    const runsBeforeThis = priorRuns.filter((item) => item.id !== run.id && item.createdAt <= run.createdAt);
    const runResults = await Promise.all(runsBeforeThis.map(async (item) => {
      const stages = await AgentStageExecution.findAll({ where: { runId: item.id }, order: [['stageIndex', 'ASC']] });
      return {
        id: item.id,
        previousRunId: item.previousRunId,
        trigger: item.trigger,
        triggerCommentId: item.triggerCommentId,
        status: item.status,
        resultSummary: item.resultSummary,
        errorMessage: item.errorMessage,
        stages: stages.map((stage) => ({ role: stage.role, status: stage.status, output: stage.output, errorMessage: stage.errorMessage })),
      };
    }));
    return { primaryPrompt, messages, priorRuns: runResults };
  }
}
