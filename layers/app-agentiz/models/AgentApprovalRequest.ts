import { Table, Column, Model, DataType, BelongsTo, ForeignKey, Default, Index } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentProject } from './AgentProject';
import { AgentTask } from './AgentTask';

export type AgentApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';

/** What a person is offered to look at before deciding — a preview, a branch, a pull request. */
export interface AgentApprovalLink {
  label: string;
  url: string;
}

/**
 * "Человек должен решить" as a row that outlives everything around it.
 *
 * Agentiz already had a way to ask a person something — `AgentRunInteraction` — and it is the
 * wrong one here: an interaction is tied to a live worker lease (`runId` + `jobId` + `attempt` +
 * `stageExecutionId`) and dies with it, because the agent is literally parked mid-turn waiting
 * for the answer. This one is the opposite: nobody is parked, no directory is held by it, and the
 * person may take days. It survives the run that produced it, the worker that ran it, a restart
 * and a deploy, and it closes only on a decision or on the flow that opened it being cancelled.
 *
 * Addressed by **token**, not by role and not by group (`assigneeToken`, default
 * `agentiz-approval-decide`): roles are a ladder, and a role invented tomorrow that carries the
 * token has to start receiving these without anyone editing a node. `recipientsForProject(projectId,
 * token)` turns that into people; `can(actor, projectId, token)` is what the deciding endpoints
 * check. `assigneeUserId` narrows it to one person ("эту фичу смотрит Пётр") and does not widen
 * anything — the token is still required.
 *
 * `workflowRunId` + `nodeId` are how the engine finds it again: the external ref an
 * `agentiz.approval` node parks on is `approval:<id>` (see lib/workflow/engineBridge.ts). Both are
 * nullable because a request may also be raised without a graph at all.
 */
@AdminizerModel({
  model: 'AgentApprovalRequest',
  title: 'Approvals',
  icon: 'checklist',
  navbar: { visible: false, section: 'Agentiz' },
})
@Table({
  tableName: 'agentiz_approval_requests',
  timestamps: true,
  indexes: [
    { name: 'agentiz_approvals_project_idx', fields: ['projectId', 'status'] },
    { name: 'agentiz_approvals_task_idx', fields: ['taskId', 'status'] },
    { name: 'agentiz_approvals_node_idx', fields: ['workflowRunId', 'nodeId'] },
  ],
})
export class AgentApprovalRequest extends Model<
  InferAttributes<AgentApprovalRequest>,
  InferCreationAttributes<AgentApprovalRequest>
> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @AdminizerField({ title: 'Project', required: true })
  @ForeignKey(() => AgentProject)
  @Column({ type: DataType.STRING, allowNull: false })
  declare projectId: string;

  /** NULL for a request that is not about one task — a release gate covers several. */
  @ForeignKey(() => AgentTask)
  @Column({ type: DataType.STRING, allowNull: true })
  declare taskId: CreationOptional<string | null>;

  @Column({ type: DataType.STRING, allowNull: true })
  declare workflowRunId: CreationOptional<string | null>;

  @Column({ type: DataType.STRING, allowNull: true })
  declare nodeId: CreationOptional<string | null>;

  /** The run whose result is being shown to the person, when there is one. */
  @Column({ type: DataType.STRING, allowNull: true })
  declare runId: CreationOptional<string | null>;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare assigneeUserId: CreationOptional<number | null>;

  /** The project token that both addresses this request and gates deciding it. */
  @Column({ type: DataType.STRING, allowNull: false })
  declare assigneeToken: string;

  @AdminizerField({ title: 'Title', required: true })
  @Column({ type: DataType.STRING, allowNull: false })
  declare title: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare message: CreationOptional<string | null>;

  /** `[{ label, url }]` — what the person opens to check before deciding. */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare links: CreationOptional<AgentApprovalLink[] | null>;

  @Default('pending')
  @Column({ type: DataType.ENUM('pending', 'approved', 'rejected', 'cancelled', 'expired'), allowNull: false })
  declare status: CreationOptional<AgentApprovalStatus>;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare decidedByUserId: CreationOptional<number | null>;

  @Column({ type: DataType.DATE, allowNull: true })
  declare decidedAt: CreationOptional<Date | null>;

  /** Why it was rejected — this text is what goes back to the agent as the next instruction. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare decisionComment: CreationOptional<string | null>;

  @Column({ type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
  declare createdAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
  declare updatedAt: CreationOptional<Date>;

  /** The alias the access graph reaches the root through (`parent: 'project'`). */
  @BelongsTo(() => AgentProject, 'projectId')
  declare project: AgentProject;

  @BelongsTo(() => AgentTask, 'taskId')
  declare task: AgentTask | null;
}

/** The statuses in which nobody is waiting any more. */
export const APPROVAL_TERMINAL_STATUSES: readonly AgentApprovalStatus[] = ['approved', 'rejected', 'cancelled', 'expired'];
