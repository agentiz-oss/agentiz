import { randomUUID } from 'crypto';
import { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';
import {
  AdminizerField,
  AdminizerModel,
} from '@nodeknit/app-adminizer';
import {
  BelongsTo,
  Column,
  DataType,
  Default,
  ForeignKey,
  Model,
  Table,
} from 'sequelize-typescript';
import { AgentProject } from './AgentProject';
import { AgentRun } from './AgentRun';
import { AgentRunJob } from './AgentRunJob';
import { AgentStageExecution } from './AgentStageExecution';
import type {
  AgentRunInteractionAction,
  AgentRunInteractionKind,
  AgentRunInteractionStatus,
} from '../types/agentiz';

/** Durable request/response history for questions asked during one leased worker attempt. */
@AdminizerModel({
  model: 'AgentRunInteraction',
  title: 'Agent Run Interactions',
  icon: 'question_answer',
  userAccessRelation: { field: 'project', via: 'owner' },
  navbar: { visible: false },
})
@Table({ tableName: 'agentiz_run_interactions', timestamps: true })
export class AgentRunInteraction extends Model<
  InferAttributes<AgentRunInteraction>,
  InferCreationAttributes<AgentRunInteraction>
> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @ForeignKey(() => AgentProject)
  @Column({ type: DataType.STRING, allowNull: false })
  declare projectId: string;

  @ForeignKey(() => AgentRun)
  @Column({ type: DataType.STRING, allowNull: false })
  declare runId: string;

  @ForeignKey(() => AgentRunJob)
  @Column({ type: DataType.STRING, allowNull: false })
  declare jobId: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare attempt: number;

  @ForeignKey(() => AgentStageExecution)
  @Column({ type: DataType.STRING, allowNull: false })
  declare stageExecutionId: string;

  @AdminizerField({ title: 'Kind', views: { list: true, add: false, edit: false } })
  @Default('elicitation')
  @Column({ type: DataType.ENUM('elicitation'), allowNull: false, defaultValue: 'elicitation' })
  declare kind: AgentRunInteractionKind;

  @Column({ type: DataType.STRING, allowNull: false })
  declare source: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare externalRequestId: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare toolCallId: string | null;

  @AdminizerField({ title: 'Question', type: 'longtext', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.TEXT, allowNull: false })
  declare message: string;

  @Column({ type: DataType.JSONB, allowNull: false })
  declare requestedSchema: Record<string, unknown>;

  @AdminizerField({ title: 'Status', views: { list: true, add: false, edit: false } })
  @Default('pending')
  @Column({
    type: DataType.ENUM('pending', 'answered', 'delivered', 'cancelled', 'expired', 'orphaned'),
    allowNull: false,
    defaultValue: 'pending',
  })
  declare status: AgentRunInteractionStatus;

  @Column({ type: DataType.ENUM('accept', 'decline', 'cancel'), allowNull: true })
  declare responseAction: AgentRunInteractionAction | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare responseContent: Record<string, unknown> | null;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare answeredById: number | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare answeredByName: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare answeredAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare deliveredAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare expiresAt: Date | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare meta: Record<string, unknown> | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: Date;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: Date;

  @BelongsTo(() => AgentProject, 'projectId')
  declare project: AgentProject;

  @BelongsTo(() => AgentRun, 'runId')
  declare run: AgentRun;

  @BelongsTo(() => AgentRunJob, 'jobId')
  declare job: AgentRunJob;

  @BelongsTo(() => AgentStageExecution, 'stageExecutionId')
  declare stageExecution: AgentStageExecution;
}
