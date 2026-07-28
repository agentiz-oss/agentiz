import { Table, Column, Model, DataType, BelongsTo, ForeignKey, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AgentRun } from './AgentRun';
import { AgentRunJob } from './AgentRunJob';

@Table({
  tableName: 'agentiz_run_event_dedup',
  timestamps: true,
  indexes: [{ unique: true, fields: ['jobId', 'attempt', 'eventId'], name: 'agentiz_run_event_dedup_unique' }],
})
export class AgentRunEventDedup extends Model<InferAttributes<AgentRunEventDedup>, InferCreationAttributes<AgentRunEventDedup>> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @ForeignKey(() => AgentRunJob)
  @Column({ type: DataType.STRING, allowNull: false })
  declare jobId: string;

  @ForeignKey(() => AgentRun)
  @Column({ type: DataType.STRING, allowNull: false })
  declare runId: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare attempt: number;

  @Column({ type: DataType.STRING, allowNull: false })
  declare eventId: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare sequence: number;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: Date;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: Date;

  @BelongsTo(() => AgentRunJob, 'jobId')
  declare job: AgentRunJob;

  @BelongsTo(() => AgentRun, 'runId')
  declare run: AgentRun;
}
