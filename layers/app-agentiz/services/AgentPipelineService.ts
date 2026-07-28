import { AgentProject } from '../models/AgentProject';
import { AgentRole } from '../models/AgentRole';
import { AgentRun } from '../models/AgentRun';
import { AgentRunLog } from '../models/AgentRunLog';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentStageExecution } from '../models/AgentStageExecution';
import { AgentTask } from '../models/AgentTask';
import { createGitProvider } from '../lib/git';
import type { FileChange } from '../lib/git';
import { assertValidSpec, orderedStages, resolveSpecForTask } from './PipelineSpecResolver';
import { resolveAgentExecutor } from './agents';
import type { AgentStageResult } from './agents';
import type { AgentRunTrigger, AgentTaskStatus, PipelineSpecDef } from '../types/agentiz';

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => values[key] ?? '');
}

async function writeLog(
  runId: string,
  stageExecutionId: string | null,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  await AgentRunLog.create({ runId, stageExecutionId, level, message, meta: meta ?? null });
}

export class AgentPipelineService {
  /**
   * Creates a run for a task: resolves which spec applies, freezes it into the run, and
   * pre-creates one pending AgentStageExecution per stage. Nothing is executed yet.
   */
  static async createRun(taskId: string, trigger: AgentRunTrigger = 'manual'): Promise<AgentRun> {
    const task = await AgentTask.findByPk(taskId);
    if (!task) throw new Error(`AgentTask ${taskId} not found`);

    const spec = await resolveSpecForTask(task);
    const snapshot = spec.spec as PipelineSpecDef;
    assertValidSpec(snapshot);

    const run = await AgentRun.create({
      taskId: task.id,
      projectId: task.projectId,
      status: 'pending',
      trigger,
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
    await writeLog(run.id, null, 'info', `Run created from spec "${spec.name}" with ${stages.length} stage(s)`, {
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

    await run.update({ status: 'running', startedAt: new Date() });
    await task.update({ status: 'running' });

    const stages = orderedStages(run.pipelineSnapshot);
    const previousOutputs: Record<string, AgentStageResult> = {};
    const changesByPath = new Map<string, FileChange>();
    let failed = false;
    let failureMessage: string | null = null;

    for (const [index, stage] of stages.entries()) {
      const execution = await AgentStageExecution.findOne({ where: { runId: run.id, stageIndex: index } });
      if (!execution) continue;

      if (failed) {
        await execution.update({ status: 'skipped', finishedAt: new Date() });
        await writeLog(run.id, execution.id, 'warn', `Stage ${stage.order} (${stage.role}) skipped after earlier failure`);
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
          log: (level, message, meta) => writeLog(run.id, execution.id, level, message, meta),
        });

        previousOutputs[stage.role] = result;
        for (const change of result.fileChanges ?? []) {
          changesByPath.set(change.path, change);
        }

        await execution.update({
          status: 'succeeded',
          output: { ...result.output, summary: result.summary },
          finishedAt: new Date(),
        });
        await writeLog(run.id, execution.id, 'info', `Stage ${stage.order} (${stage.role}) succeeded: ${result.summary}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await execution.update({ status: 'failed', errorMessage: message, finishedAt: new Date() });
        await writeLog(run.id, execution.id, 'error', `Stage ${stage.order} (${stage.role}) failed: ${message}`);
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
      await writeLog(run.id, null, 'error', `Run failed: ${failureMessage}`);
      return run;
    }

    try {
      await this.applyFinalAction({
        run,
        task,
        project,
        changes: [...changesByPath.values()],
        summary,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await run.update({ status: 'failed', finishedAt: new Date(), resultSummary: summary || null, errorMessage: message });
      await task.update({ status: 'failed' });
      await writeLog(run.id, null, 'error', `Final action failed: ${message}`);
      return run;
    }

    await run.update({ status: 'succeeded', finishedAt: new Date(), resultSummary: summary || null, errorMessage: null });
    const finalTaskStatus: AgentTaskStatus =
      run.pipelineSnapshot.finalAction.type === 'commit_and_pr' ? 'waiting_review' : 'done';
    await task.update({ status: finalTaskStatus });
    await writeLog(run.id, null, 'info', `Run succeeded, task moved to "${finalTaskStatus}"`);

    return run;
  }

  /** Creates the run and queues exactly one durable worker job. Execution happens out of request. */
  static async runTask(taskId: string, trigger: AgentRunTrigger = 'manual'): Promise<AgentRun> {
    const run = await this.createRun(taskId, trigger);
    await AgentWorkerJobBuilder.enqueueRun(run);
    return run;
  }

  static async applyFinalAction(params: {
    run: AgentRun;
    task: AgentTask;
    project: AgentProject;
    changes: FileChange[];
    summary: string;
  }): Promise<void> {
    const { run, task, project, changes, summary } = params;
    const action = run.pipelineSnapshot.finalAction;
    const templateValues = {
      taskId: task.id,
      externalId: task.externalId,
      title: task.title,
      summary,
    };

    if (action.type === 'none') {
      await writeLog(run.id, null, 'info', 'Final action: none, nothing pushed back');
      return;
    }

    const provider = createGitProvider(project);

    if (action.type === 'comment_only') {
      const body = `Agentiz run \`${run.id}\` finished.\n\n${summary}`;
      const comment = await provider.commentOnTask(task.externalId, body);
      await run.update({ responseUrl: comment.url });
      await writeLog(run.id, null, 'info', `Final action: commented on task, ${comment.url}`);
      return;
    }

    if (changes.length === 0) {
      throw new Error('Final action commit_and_pr requested but no stage produced file changes');
    }

    const branch = `${action.branchPrefix ?? 'agentiz/'}${task.externalId}`;
    const message = renderTemplate(
      action.commitMessageTemplate ?? 'agentiz: {{title}} (#{{externalId}})',
      templateValues,
    );

    const commit = await provider.commitChanges({
      branch,
      baseBranch: project.repoConfig.defaultBranch,
      message,
      changes,
    });
    await run.update({ commitSha: commit.sha, commitUrl: commit.url });
    await writeLog(run.id, null, 'info', `Committed ${changes.length} file(s) to ${branch}: ${commit.url}`);

    const pr = await provider.openPullRequest({
      branch,
      baseBranch: project.repoConfig.defaultBranch,
      title: renderTemplate(action.pullRequestTitleTemplate ?? 'agentiz: {{title}}', templateValues),
      body: `Automated by agentiz run \`${run.id}\` for task #${task.externalId}.\n\n${summary}`,
    });
    await run.update({ responseUrl: pr.url });
    await writeLog(run.id, null, 'info', `Opened pull request ${pr.url}`);
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
      await writeLog(run.id, null, 'warn', `Queued run cancelled: ${reason}`);
      return run;
    }
    if (job && (job.status === 'leased' || job.status === 'running')) {
      await job.update({ cancelRequestedAt: new Date(), cancelReason: reason });
      await writeLog(run.id, null, 'warn', `Cancel requested for worker job: ${reason}`);
      return run;
    }
    await run.update({ status: 'cancelled', finishedAt: new Date(), errorMessage: reason });
    await AgentTask.update({ status: 'cancelled' }, { where: { id: run.taskId } });
    await writeLog(run.id, null, 'warn', `Run cancelled: ${reason}`);
    return run;
  }

  static async log(
    runId: string,
    stageExecutionId: string | null,
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    await writeLog(runId, stageExecutionId, level, message, meta);
  }
}

export class AgentWorkerJobBuilder {
  static async enqueueRun(run: AgentRun): Promise<AgentRunJob> {
    const snapshot = await this.buildSnapshot(run);
    const [job, created] = await AgentRunJob.findOrCreate({
      where: { runId: run.id },
      defaults: {
        runId: run.id,
        projectId: run.projectId,
        status: 'queued',
        priority: 100,
        attempt: 0,
        workerId: null,
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
      await job.update({ status: 'queued', availableAt: new Date(), snapshot });
    }
    if (created) {
      await writeLog(run.id, null, 'info', 'Worker job queued', { jobId: job.id });
    }
    return job;
  }

  static async buildSnapshot(run: AgentRun): Promise<Record<string, unknown>> {
    const [task, project] = await Promise.all([
      AgentTask.findByPk(run.taskId),
      AgentProject.findByPk(run.projectId),
    ]);
    if (!task || !project) throw new Error(`AgentRun ${run.id}: task or project is missing`);

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
        systemPrompt: role?.systemPrompt ?? null,
        agent: {
          kind: String((role?.config as any)?.executor ?? 'stub'),
          model: role?.model ?? null,
          allowedTools: role?.allowedTools ?? [],
          config: role?.config ?? {},
        },
      };
    }));

    const baseHost = project.repoConfig.baseUrl
      ? project.repoConfig.baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
      : project.repoProvider === 'gitlab' ? 'gitlab.com' : 'github.com';
    const cloneUrl = `https://${baseHost}/${project.repoConfig.owner}/${project.repoConfig.repo}.git`;
    return {
      schemaVersion: 1,
      runId: run.id,
      repository: {
        provider: project.repoProvider,
        cloneUrl,
        owner: project.repoConfig.owner,
        repo: project.repoConfig.repo,
        baseRef: project.repoConfig.defaultBranch ?? 'main',
      },
      task: {
        id: task.id,
        externalId: task.externalId,
        title: task.title,
        description: task.description ?? '',
        tags: task.tags ?? [],
        externalUrl: task.externalUrl,
      },
      stages,
      finalAction: run.pipelineSnapshot.finalAction,
      validation: { commands: [], timeoutSec: 1800 },
      limits: { jobTimeoutSec: 3600, maxOutputBytes: 10485760 },
    };
  }
}
