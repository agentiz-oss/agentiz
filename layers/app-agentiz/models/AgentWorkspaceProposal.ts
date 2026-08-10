import { Table, Column, Model, DataType, BelongsTo, ForeignKey, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentProject } from './AgentProject';
import { AgentTask } from './AgentTask';
import type { AgentWorkspaceProposalStatus } from '../types/agentiz';

@AdminizerModel({
  model: 'AgentWorkspaceProposal',
  title: 'Workspace Proposals',
  icon: 'rate_review',
  userAccessRelation: { field: 'project', via: 'owner' },
  navbar: { visible: true, section: 'Agentiz' },
})
@Table({ tableName: 'agentiz_workspace_proposals', timestamps: true })
export class AgentWorkspaceProposal extends Model<
  InferAttributes<AgentWorkspaceProposal>, InferCreationAttributes<AgentWorkspaceProposal>
> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @ForeignKey(() => AgentProject)
  @Column({ type: DataType.STRING, allowNull: false })
  declare projectId: string;

  @ForeignKey(() => AgentTask)
  @Column({ type: DataType.STRING, allowNull: false })
  declare taskId: string;

  /**
   * The hosted repository this change belongs to, when the pipeline pinned one. Null for a plain
   * worker directory: it pushes through its own `origin`, and Agentiz has no reason to invent a
   * repository record for a folder somebody maintains by hand.
   */
  @Column({ type: DataType.STRING, allowNull: true }) declare repositoryId: string | null;
  @Column({ type: DataType.STRING, allowNull: false }) declare workerId: string;
  /** The worker's declared key, or the absolute path when the spec named the directory directly. */
  @Column({ type: DataType.STRING, allowNull: false }) declare workspaceKey: string;
  @Column({ type: DataType.STRING, allowNull: false }) declare workspacePath: string;
  /** Unique while active; cleared only after pushed/rejected. */
  @Column({ type: DataType.STRING, allowNull: true, unique: true }) declare reservationKey: string | null;
  @Column({ type: DataType.STRING, allowNull: false }) declare initialRunId: string;
  @Column({ type: DataType.STRING, allowNull: false }) declare latestRunId: string;
  @Default(1)
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 }) declare revision: CreationOptional<number>;
  @Column({ type: DataType.STRING, allowNull: true }) declare latestDiffId: string | null;
  @Column({ type: DataType.STRING, allowNull: true }) declare baseSha: string | null;
  @Column({ type: DataType.STRING, allowNull: true }) declare baseBranch: string | null;
  @Column({ type: DataType.STRING, allowNull: false }) declare remote: string;
  @Column({ type: DataType.STRING, allowNull: true }) declare remoteUrl: string | null;
  @Column({ type: DataType.STRING, allowNull: true }) declare remoteBaseSha: string | null;
  @Column({ type: DataType.STRING, allowNull: true }) declare expectedTreeSha: string | null;
  @Column({ type: DataType.STRING, allowNull: false }) declare targetMode: 'current' | 'new';
  @Column({ type: DataType.STRING, allowNull: true }) declare targetBranch: string | null;
  @Column({ type: DataType.TEXT, allowNull: false }) declare commitMessage: string;

  @AdminizerField({ title: 'Status', views: { list: true, add: false, edit: false } })
  @Default('working')
  @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'working' })
  declare status: AgentWorkspaceProposalStatus;

  @Column({ type: DataType.STRING, allowNull: true }) declare decisionActor: string | null;
  @Column({ type: DataType.DATE, allowNull: true }) declare decisionAt: Date | null;
  @Column({ type: DataType.TEXT, allowNull: true }) declare lastError: string | null;
  @Column({ type: DataType.STRING, allowNull: true }) declare pushedCommitSha: string | null;
  @Column({ type: DataType.DATE, allowNull: true }) declare pushedAt: Date | null;
  @Column({ type: DataType.DATE, allowNull: true }) declare rejectedAt: Date | null;
  @Column({ type: DataType.DATE, defaultValue: DataType.NOW }) declare createdAt: CreationOptional<Date>;
  @Column({ type: DataType.DATE, defaultValue: DataType.NOW }) declare updatedAt: CreationOptional<Date>;

  @BelongsTo(() => AgentProject, 'projectId') declare project: AgentProject;
  @BelongsTo(() => AgentTask, 'taskId') declare task: AgentTask;
}
