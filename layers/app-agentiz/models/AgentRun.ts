import { Table, Column, Model, DataType, BelongsTo, HasMany, ForeignKey, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentProject } from './AgentProject';
import { AgentTask } from './AgentTask';
import { AgentStageExecution } from './AgentStageExecution';
import { AgentRunLog } from './AgentRunLog';
import type { AgentRunStatus, AgentRunTrigger, PipelineSpecDef } from '../types/agentiz';

/**
 * "У каждой задачи будут запуски" - one row per pipeline execution attempt for an AgentTask.
 * `pipelineSnapshot` freezes the PipelineSpec that was resolved when the run was created, so
 * editing the spec later never rewrites history for runs that already happened.
 */
@AdminizerModel({
  model: 'AgentRun',
  title: 'Agent Runs',
  icon: 'directions_run',
  userAccessRelation: { field: 'project', via: 'owner' },
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

  @AdminizerField({
    title: 'Status',
    type: 'select',
    isIn: { pending: 'Pending', running: 'Running', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled' },
    views: { list: true, add: false, edit: true },
  })
  @Default('pending')
  @Column({
    type: DataType.ENUM('pending', 'running', 'succeeded', 'failed', 'cancelled'),
    allowNull: false,
    defaultValue: 'pending',
  })
  declare status: AgentRunStatus;

  @AdminizerField({
    title: 'Trigger',
    type: 'select',
    isIn: { sync: 'Sync', manual: 'Manual', webhook: 'Webhook', schedule: 'Schedule' },
    views: { list: true, add: false, edit: false },
  })
  @Default('manual')
  @Column({
    type: DataType.ENUM('sync', 'manual', 'webhook', 'schedule'),
    allowNull: false,
    defaultValue: 'manual',
  })
  declare trigger: AgentRunTrigger;

  @AdminizerField({ title: 'Pipeline Snapshot', type: 'jsoneditor', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.JSONB, allowNull: false })
  declare pipelineSnapshot: PipelineSpecDef;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare currentStageIndex: number;

  @Column({ type: DataType.DATE, allowNull: true })
  declare startedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare finishedAt: Date | null;

  @AdminizerField({ title: 'Result summary', type: 'longtext', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.TEXT, allowNull: true })
  declare resultSummary: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare commitSha: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare commitUrl: string | null;

  @AdminizerField({ title: 'Response URL', tooltip: 'Link to the PR/comment posted back to the tracker', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare responseUrl: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare errorMessage: string | null;

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
}
