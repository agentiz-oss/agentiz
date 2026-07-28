import { Table, Column, Model, DataType, BelongsTo, HasMany, ForeignKey, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentProject } from './AgentProject';
import { PipelineSpec } from './PipelineSpec';
import { AgentRun } from './AgentRun';
import type { AgentTaskStatus } from '../types/agentiz';

/**
 * A task pulled from the external tracker (GitHub/GitLab issue) and mirrored locally so we can
 * track our own pipeline lifecycle (`status`) separately from the tracker's own state
 * (`externalStatus`). See services/GitSyncService for the upsert logic.
 */
@AdminizerModel({
  model: 'AgentTask',
  title: 'Agentiz Tasks',
  icon: 'task_alt',
  userAccessRelation: { field: 'project', via: 'owner' },
  navbar: {
    visible: true,
    section: 'Agentiz',
  },
})
@Table({ tableName: 'agentiz_tasks', timestamps: true })
export class AgentTask extends Model<InferAttributes<AgentTask>, InferCreationAttributes<AgentTask>> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @ForeignKey(() => AgentProject)
  @Column({ type: DataType.STRING, allowNull: false })
  declare projectId: string;

  @AdminizerField({ title: 'External ID', required: true, views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare externalId: string;

  @AdminizerField({ title: 'External URL', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare externalUrl: string | null;

  @AdminizerField({ title: 'Title', required: true, views: { list: true, add: true, edit: true } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare title: string;

  @AdminizerField({ title: 'Description', type: 'longtext', views: { list: false, add: true, edit: true } })
  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  @AdminizerField({ title: 'Tags', type: 'jsoneditor', tooltip: 'Labels from the tracker, matched against PipelineSpec.matchTags', views: { list: true, add: true, edit: true } })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare tags: string[] | null;

  @AdminizerField({ title: 'External Status', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare externalStatus: string | null;

  @AdminizerField({
    title: 'Pipeline Status',
    type: 'select',
    isIn: {
      new: 'New',
      queued: 'Queued',
      running: 'Running',
      waiting_review: 'Waiting review',
      done: 'Done',
      failed: 'Failed',
      cancelled: 'Cancelled',
      ignored: 'Ignored',
    },
    views: { list: true, add: false, edit: true },
  })
  @Default('new')
  @Column({
    type: DataType.ENUM('new', 'queued', 'running', 'waiting_review', 'done', 'failed', 'cancelled', 'ignored'),
    allowNull: false,
    defaultValue: 'new',
  })
  declare status: AgentTaskStatus;

  @ForeignKey(() => PipelineSpec)
  @Column({ type: DataType.STRING, allowNull: true })
  declare pipelineSpecId: string | null;

  @AdminizerField({ title: 'Raw payload', type: 'jsoneditor', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare raw: Record<string, unknown> | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastSyncedAt: Date | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: Date;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: Date;

  @AdminizerField({ title: 'Project', required: true, views: { list: true, add: true, edit: true } })
  @BelongsTo(() => AgentProject, 'projectId')
  declare project: AgentProject;

  @BelongsTo(() => PipelineSpec, 'pipelineSpecId')
  declare pipelineSpec: PipelineSpec | null;

  @HasMany(() => AgentRun, 'taskId')
  declare runs: AgentRun[];
}
