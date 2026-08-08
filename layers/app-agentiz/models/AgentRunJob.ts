import { Table, Column, Model, DataType, BelongsTo, ForeignKey, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentRun } from './AgentRun';
import { AgentProject } from './AgentProject';
import type { AgentRunJobStatus } from '../types/agentiz';

@AdminizerModel({
  model: 'AgentRunJob',
  title: 'Agent Run Jobs',
  icon: 'work_history',
  userAccessRelation: { field: 'project', via: 'owner' },
  navbar: {
    visible: true,
    section: 'Agentiz',
  },
})
@Table({ tableName: 'agentiz_run_jobs', timestamps: true })
export class AgentRunJob extends Model<InferAttributes<AgentRunJob>, InferCreationAttributes<AgentRunJob>> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @ForeignKey(() => AgentRun)
  @Column({ type: DataType.STRING, allowNull: false })
  declare runId: string;

  @ForeignKey(() => AgentProject)
  @Column({ type: DataType.STRING, allowNull: false })
  declare projectId: string;

  @AdminizerField({
    title: 'Status',
    type: 'select',
    isIn: {
      queued: 'Queued',
      leased: 'Leased',
      running: 'Running',
      succeeded: 'Succeeded',
      failed: 'Failed',
      cancelled: 'Cancelled',
      released: 'Released',
      dead: 'Dead',
    },
    views: { list: true, add: false, edit: false },
  })
  @Default('queued')
  @Column({
    type: DataType.ENUM('queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled', 'released', 'dead'),
    allowNull: false,
    defaultValue: 'queued',
  })
  declare status: AgentRunJobStatus;

  @Default(100)
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 100 })
  declare priority: CreationOptional<number>;

  @Default(0)
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare attempt: CreationOptional<number>;

  @Column({ type: DataType.STRING, allowNull: true })
  declare workerId: string | null;

  /**
   * Repository the run works on, mirrored out of `snapshot.repository`.
   *
   * A real column rather than a JSON field because the claim query filters on it in SQL under
   * `FOR UPDATE SKIP LOCKED`, and JSON filtering is written differently in postgres and sqlite —
   * this project runs on both. Null = the run touches no repository (`finalAction: none`).
   */
  @AdminizerField({
    title: 'Repository',
    tooltip: 'AgentRepository the run works on. Empty = the run touches no repository.',
    views: { list: true, add: false, edit: false },
  })
  @Column({ type: DataType.STRING, allowNull: true })
  declare repositoryId: string | null;

  /**
   * Set when the run can only execute on one machine — currently a pipeline whose source is a
   * directory on that worker. Enforced in the claim query itself, so a job nobody else can run is
   * never handed out and silently failed.
   */
  @AdminizerField({
    title: 'Pinned worker',
    tooltip: 'Only this worker may claim the job. Empty = any eligible worker.',
    views: { list: false, add: false, edit: false },
  })
  @Column({ type: DataType.STRING, allowNull: true })
  declare requiredWorkerId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare leaseTokenHash: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lockedUntil: Date | null;

  @Column({ type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
  declare availableAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, allowNull: true })
  declare cancelRequestedAt: Date | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare cancelReason: string | null;

  @Column({ type: DataType.JSONB, allowNull: false })
  declare snapshot: Record<string, unknown>;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare result: Record<string, unknown> | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare lastError: string | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: Date;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: Date;

  @BelongsTo(() => AgentRun, 'runId')
  declare run: AgentRun;

  @BelongsTo(() => AgentProject, 'projectId')
  declare project: AgentProject;
}
