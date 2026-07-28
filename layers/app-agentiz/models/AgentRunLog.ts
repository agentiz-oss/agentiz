import { Table, Column, Model, DataType, BelongsTo, ForeignKey, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentRun } from './AgentRun';
import { AgentStageExecution } from './AgentStageExecution';
import type { AgentRunLogLevel } from '../types/agentiz';

/** "По каждой задаче будут логи" - append-only log lines for a run, optionally tied to one stage. */
@AdminizerModel({
  model: 'AgentRunLog',
  title: 'Agent Run Logs',
  icon: 'article',
  navbar: {
    visible: false,
  },
})
@Table({ tableName: 'agentiz_run_logs', timestamps: true })
export class AgentRunLog extends Model<InferAttributes<AgentRunLog>, InferCreationAttributes<AgentRunLog>> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @ForeignKey(() => AgentRun)
  @Column({ type: DataType.STRING, allowNull: false })
  declare runId: string;

  @ForeignKey(() => AgentStageExecution)
  @Column({ type: DataType.STRING, allowNull: true })
  declare stageExecutionId: string | null;

  @AdminizerField({
    title: 'Level',
    type: 'select',
    isIn: { debug: 'Debug', info: 'Info', warn: 'Warn', error: 'Error' },
    views: { list: true, add: false, edit: false },
  })
  @Default('info')
  @Column({
    type: DataType.ENUM('debug', 'info', 'warn', 'error'),
    allowNull: false,
    defaultValue: 'info',
  })
  declare level: AgentRunLogLevel;

  @AdminizerField({ title: 'Message', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.TEXT, allowNull: false })
  declare message: string;

  @AdminizerField({ title: 'Meta', type: 'jsoneditor', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare meta: Record<string, unknown> | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: Date;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: Date;

  @BelongsTo(() => AgentRun, 'runId')
  declare run: AgentRun;

  @BelongsTo(() => AgentStageExecution, 'stageExecutionId')
  declare stageExecution: AgentStageExecution | null;
}
