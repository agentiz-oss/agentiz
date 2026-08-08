import { Table, Column, Model, DataType, BelongsTo, ForeignKey, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentRun } from './AgentRun';
import { AgentProject } from './AgentProject';
import type { FileOp } from '../lib/git';

export interface AgentRunDiffStats {
  files: number;
  insertions: number;
  deletions: number;
}

/**
 * What the agent changed, stored in Agentiz whatever happens next.
 *
 * Written **before** the final action runs, which is the whole point: a failed push used to take
 * the entire work product with it — the run went `failed` and an hour of agent time left no trace.
 * Now the diff exists either way, and `requireApproval` can hold it back deliberately.
 *
 * `ops` is what gets applied; `patch` is the exact record of what the agent did, kept for audit and
 * as the source of truth when the two disagree.
 */
@AdminizerModel({
  model: 'AgentRunDiff',
  title: 'Run Diffs',
  icon: 'difference',
  userAccessRelation: { field: 'project', via: 'owner' },
  navbar: {
    visible: true,
    section: 'Agentiz',
  },
})
@Table({ tableName: 'agentiz_run_diffs', timestamps: true })
export class AgentRunDiff extends Model<InferAttributes<AgentRunDiff>, InferCreationAttributes<AgentRunDiff>> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  /** One diff per run — the unique index is what makes a retry overwrite instead of accumulate. */
  @ForeignKey(() => AgentRun)
  @AdminizerField({ title: 'Run', required: true, views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false, unique: true })
  declare runId: string;

  @ForeignKey(() => AgentProject)
  @Column({ type: DataType.STRING, allowNull: false })
  declare projectId: string;

  @AdminizerField({ title: 'Repository', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare repositoryId: string | null;

  @AdminizerField({ title: 'Base commit', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare baseSha: string | null;

  @AdminizerField({ title: 'Patch', type: 'longtext', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.TEXT, allowNull: true })
  declare patch: string | null;

  @AdminizerField({ title: 'Operations', type: 'jsoneditor', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare ops: FileOp[] | null;

  @AdminizerField({ title: 'Stats', type: 'jsoneditor', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare stats: AgentRunDiffStats | null;

  /**
   * The patch was cut at AGENTIZ_MAX_PATCH_BYTES. Cutting rather than refusing: a truncated patch
   * still shows what was going on, and the operations — which are what gets applied — are complete
   * either way.
   */
  @AdminizerField({ title: 'Patch truncated', type: 'boolean', views: { list: true, add: false, edit: false } })
  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare truncated: CreationOptional<boolean>;

  /** Null while the change is still held in Agentiz; set once it reached the repository. */
  @AdminizerField({ title: 'Applied at', type: 'datetime', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.DATE, allowNull: true })
  declare appliedAt: Date | null;

  @AdminizerField({ title: 'Applied commit', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare appliedCommitSha: string | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: CreationOptional<Date>;

  @BelongsTo(() => AgentRun, 'runId')
  declare run: AgentRun;

  @BelongsTo(() => AgentProject, 'projectId')
  declare project: AgentProject;
}
