import { Table, Column, Model, DataType, BelongsTo, HasMany, ForeignKey, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentRun } from './AgentRun';
import { AgentRole } from './AgentRole';
import { AgentRunLog } from './AgentRunLog';
import type { AgentStageStatus } from '../types/agentiz';

/**
 * "Сначала запускается 1 агент, потом 2, потом 3" - one row per stage of a run, in `stageIndex`
 * order. AgentPipelineService creates these upfront (status=pending) from the run's
 * pipelineSnapshot.stages, then flips them to running/succeeded/failed as it executes them.
 */
@AdminizerModel({
  model: 'AgentStageExecution',
  title: 'Agent Stage Executions',
  icon: 'linear_scale',
  navbar: {
    visible: false,
  },
})
@Table({ tableName: 'agentiz_stage_executions', timestamps: true })
export class AgentStageExecution extends Model<InferAttributes<AgentStageExecution>, InferCreationAttributes<AgentStageExecution>> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @ForeignKey(() => AgentRun)
  @Column({ type: DataType.STRING, allowNull: false })
  declare runId: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare stageIndex: number;

  @Column({ type: DataType.STRING, allowNull: false })
  declare role: string;

  @ForeignKey(() => AgentRole)
  @Column({ type: DataType.STRING, allowNull: true })
  declare agentRoleId: string | null;

  @AdminizerField({
    title: 'Status',
    type: 'select',
    isIn: { pending: 'Pending', running: 'Running', succeeded: 'Succeeded', failed: 'Failed', skipped: 'Skipped' },
    views: { list: true, add: false, edit: false },
  })
  @Default('pending')
  @Column({
    type: DataType.ENUM('pending', 'running', 'succeeded', 'failed', 'skipped'),
    allowNull: false,
    defaultValue: 'pending',
  })
  declare status: AgentStageStatus;

  @AdminizerField({ title: 'Input', type: 'jsoneditor', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare input: Record<string, unknown> | null;

  @AdminizerField({ title: 'Output', type: 'jsoneditor', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare output: Record<string, unknown> | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare startedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare finishedAt: Date | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare errorMessage: string | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: Date;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: Date;

  @BelongsTo(() => AgentRun, 'runId')
  declare run: AgentRun;

  @BelongsTo(() => AgentRole, 'agentRoleId')
  declare agentRole: AgentRole | null;

  @HasMany(() => AgentRunLog, 'stageExecutionId')
  declare logs: AgentRunLog[];
}
