import { Table, Column, Model, DataType, BelongsTo, HasMany, ForeignKey, Default, AfterUpdate } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentProject } from './AgentProject';
import { AgentTask } from './AgentTask';
import { AgentTaskComment } from './AgentTaskComment';
import { AgentStageExecution } from './AgentStageExecution';
import { AgentRunLog } from './AgentRunLog';
import type { AgentJobDeferReason, AgentRunStatus, AgentRunTrigger, AgentRunVerdict, AgentRunExecutorOverride, PipelineSpecDef } from '../types/agentiz';

/**
 * "У каждой задачи будут запуски" - one row per pipeline execution attempt for an AgentTask.
 * `pipelineSnapshot` freezes the PipelineSpec that was resolved when the run was created, so
 * editing the spec later never rewrites history for runs that already happened.
 */
@AdminizerModel({
  model: 'AgentRun',
  title: 'Agent Runs',
  icon: 'directions_run',
  navbar: {
    visible: true,
    section: 'Agentiz',
  },
})
@Table({ tableName: 'agentiz_runs', timestamps: true })
export class AgentRun extends Model<InferAttributes<AgentRun>, InferCreationAttributes<AgentRun>> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @ForeignKey(() => AgentTask)
  @Column({ type: DataType.STRING, allowNull: false })
  declare taskId: string;

  @ForeignKey(() => AgentProject)
  @Column({ type: DataType.STRING, allowNull: false })
  declare projectId: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare proposalId: string | null;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare workspaceRevision: number | null;

  @AdminizerField({
    title: 'Status',
    type: 'select',
    isIn: { pending: 'Pending', running: 'Running', waiting_input: 'Waiting input', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled' },
    views: { list: true, add: false, edit: true },
  })
  @Default('pending')
  @Column({
    type: DataType.ENUM('pending', 'running', 'waiting_input', 'succeeded', 'failed', 'cancelled'),
    allowNull: false,
    defaultValue: 'pending',
  })
  declare status: AgentRunStatus;

  @AdminizerField({
    title: 'Trigger',
    type: 'select',
    isIn: { sync: 'Sync', manual: 'Manual', webhook: 'Webhook', schedule: 'Schedule', human_comment: 'Human comment' },
    views: { list: true, add: false, edit: false },
  })
  @Default('manual')
  @Column({
    type: DataType.ENUM('sync', 'manual', 'webhook', 'schedule', 'human_comment'),
    allowNull: false,
    defaultValue: 'manual',
  })
  declare trigger: AgentRunTrigger;

  @AdminizerField({ title: 'Manual executor override', type: 'jsoneditor', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare executorOverride: AgentRunExecutorOverride | null;

  /** Human comment that caused this run, when it was event-triggered. */
  @ForeignKey(() => AgentTaskComment)
  @Column({ type: DataType.STRING, allowNull: true })
  declare triggerCommentId: string | null;

  /** Immediately preceding run for this task when this run was created. */
  @ForeignKey(() => AgentRun)
  @Column({ type: DataType.STRING, allowNull: true })
  declare previousRunId: string | null;

  @AdminizerField({ title: 'Pipeline Snapshot', type: 'jsoneditor', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.JSONB, allowNull: false })
  declare pipelineSnapshot: PipelineSpecDef;

  /**
   * The PipelineSpec this run was created from. Not resolvable through `task.pipelineSpecId` —
   * that holds the spec of the task's *latest* run, and an older run may have used another one.
   * The notification policy's pipeline scope keys on this (lib/notifications/policySettings.ts).
   */
  @Column({ type: DataType.STRING, allowNull: true })
  declare pipelineSpecId: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare currentStageIndex: number;

  @Column({ type: DataType.DATE, allowNull: true })
  declare startedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare finishedAt: Date | null;

  @AdminizerField({ title: 'Result summary', type: 'longtext', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.TEXT, allowNull: true })
  declare resultSummary: string | null;

  /**
   * Machine-readable pass/fail read off a verdict stage's own output (lib/runVerdict.ts). `null`
   * covers two cases on purpose: no stage in this run asked for a verdict (`stage.verdict` unset),
   * or one did and neither the main attempt nor the worker's one fallback retry produced a usable
   * `AGENTIZ_VERDICT:` marker — a consumer never needs to tell those apart, only the run log does
   * (`stage.verdict_retry`).
   */
  @AdminizerField({
    title: 'Verdict',
    type: 'select',
    isIn: { pass: 'Pass', fail: 'Fail' },
    views: { list: true, add: false, edit: false },
  })
  @Column({ type: DataType.ENUM('pass', 'fail'), allowNull: true })
  declare verdict: AgentRunVerdict | null;

  @AdminizerField({ title: 'Verdict reason', type: 'longtext', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.TEXT, allowNull: true })
  declare verdictReason: string | null;

  /**
   * Token spend, accumulated across every applied worker result (so a deferred/retried attempt's
   * tokens still count — the per-stage `AgentStageExecution.output.usage` keeps only the last
   * attempt). Columns rather than JSON on purpose: charts aggregate these in SQL, and JSON
   * operators differ between the postgres and sqlite deployments. NULL means "never reported"
   * (an old run, or an executor that sends no usage) and renders as no badge, not as 0.
   */
  @AdminizerField({ title: 'Input tokens', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.BIGINT, allowNull: true })
  declare usageInputTokens: number | null;

  @AdminizerField({ title: 'Output tokens', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.BIGINT, allowNull: true })
  declare usageOutputTokens: number | null;

  @AdminizerField({ title: 'Cache read tokens', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.BIGINT, allowNull: true })
  declare usageCacheReadTokens: number | null;

  @AdminizerField({ title: 'Cache write tokens', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.BIGINT, allowNull: true })
  declare usageCacheWriteTokens: number | null;

  @AdminizerField({ title: 'Total tokens', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.BIGINT, allowNull: true })
  declare usageTotalTokens: number | null;

  /** litellm's pricing estimate; on a subscription the real marginal cost is zero. */
  @AdminizerField({ title: 'Estimated cost (USD)', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.FLOAT, allowNull: true })
  declare usageEstimatedCostUsd: number | null;

  /**
   * What the run started from: the branch that was asked for and the commit it resolved to when the
   * job was queued. Kept on the run so the final action does not have to resolve it a second time,
   * and so the run card can say which commit the work was based on.
   */
  @AdminizerField({ title: 'Base ref', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare baseRef: string | null;

  @AdminizerField({ title: 'Base commit', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare baseSha: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare commitSha: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare commitUrl: string | null;

  @AdminizerField({ title: 'Response URL', tooltip: 'Link to the PR/comment posted back to the tracker', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare responseUrl: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare errorMessage: string | null;

  /**
   * Set while the run is parked waiting for a harness limit or a schedule window; cleared by the
   * next claim (markRunStarted). Deliberately NOT a new status in the ENUM: `sync({alter})` on
   * postgres extends ENUMs unreliably, and every status consumer (mobile-api, admin selects, MCP)
   * would break on an unknown value. The run stays `running`/`pending` and the "waiting until
   * 21:00" badge is drawn from these two fields, degrading invisibly where they are unknown.
   */
  @Column({ type: DataType.DATE, allowNull: true })
  declare waitingUntil: Date | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare waitingReason: AgentJobDeferReason | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: Date;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: Date;

  @AdminizerField({ title: 'Task', required: true, views: { list: true, add: true, edit: false } })
  @BelongsTo(() => AgentTask, 'taskId')
  declare task: AgentTask;

  @BelongsTo(() => AgentProject, 'projectId')
  declare project: AgentProject;

  @HasMany(() => AgentStageExecution, 'runId')
  declare stageExecutions: AgentStageExecution[];

  @HasMany(() => AgentRunLog, 'runId')
  declare logs: AgentRunLog[];

  /**
   * Emits the run.succeeded/failed/cancelled activity on the first transition into a terminal
   * status. A model hook, not calls at the ~10 places that terminalize a run: explicit calls in
   * five files would drift apart exactly the way dual claim sites used to.
   *
   * CONSTRAINT: a terminal status must be written through an **instance** `run.update(...)`. A
   * bulk `AgentRun.update({status}, {where})` bypasses this hook and the activity is never born
   * (sequelize only runs per-instance hooks with `individualHooks`, which nothing here passes).
   * Today every terminal transition is instance-level; keep it that way.
   */
  @AfterUpdate
  static async emitTerminalActivity(instance: AgentRun): Promise<void> {
    if (!instance.changed('status')) return;
    const terminal = ['succeeded', 'failed', 'cancelled'];
    const status = instance.status;
    const previous = instance.previous('status');
    if (!terminal.includes(status) || previous === undefined || terminal.includes(String(previous))) return;
    // Dynamic import: the service imports models, so a static import here would be a cycle.
    const { ActivityService } = await import('../services/ActivityService');
    const titles: Record<string, string> = {
      succeeded: 'Запуск завершён успешно',
      failed: 'Запуск завершился с ошибкой',
      cancelled: 'Запуск отменён',
    };
    await ActivityService.record({
      type: `run.${status}`,
      projectId: instance.projectId,
      runId: instance.id,
      taskId: instance.taskId,
      proposalId: instance.proposalId ?? null,
      title: titles[status],
      body: status === 'failed'
        ? (instance.errorMessage ?? 'Причина не сообщена')
        : (instance.resultSummary ?? instance.errorMessage ?? ''),
      data: {
        status,
        ...(instance.errorMessage ? { errorMessage: instance.errorMessage.slice(0, 1000) } : {}),
        ...(instance.commitUrl ? { commitUrl: instance.commitUrl } : {}),
        ...(instance.responseUrl ? { responseUrl: instance.responseUrl } : {}),
      },
    });
  }

  /**
   * Continues a workflow parked on `agentiz.pipeline` for this run (`run:<id>`).
   *
   * A second hook rather than a branch inside the one above: that one's job is the activity feed
   * and it awaits `ActivityService.record()`, which fans out to push and the bell — a workflow
   * must not wait behind that, and neither may fail because the other did. Same instance-update
   * constraint applies: a bulk status write bypasses both.
   */
  @AfterUpdate
  static async continueWaitingWorkflow(instance: AgentRun): Promise<void> {
    if (!instance.changed('status')) return;
    const terminal = ['succeeded', 'failed', 'cancelled'];
    const previous = instance.previous('status');
    if (!terminal.includes(instance.status) || previous === undefined || terminal.includes(String(previous))) return;
    // Dynamic import for the same reason as above: the bridge pulls in the engine package.
    const { completePipelineWait } = await import('../lib/workflow/engineBridge');
    await completePipelineWait(instance.id, {
      status: instance.status,
      summary: instance.resultSummary,
      error: instance.errorMessage,
      taskId: instance.taskId,
      projectId: instance.projectId,
      verdict: instance.verdict,
    });
  }
}
