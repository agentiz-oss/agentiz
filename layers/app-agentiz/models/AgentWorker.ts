import { Table, Column, Model, DataType, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import type { AgentWorkerCapabilities, AgentWorkerKind, AgentWorkerStatus } from '../types/agentiz';

/**
 * A worker identity. Workers hold sensitive material (job snapshots with task text, prompts and
 * repository coordinates), so every worker is a first-class, auditable record instead of anyone
 * who knows a shared token: it self-enrolls, waits for an admin to approve it, and authenticates
 * with a personal token whose plain text never reaches the database.
 */
@AdminizerModel({
  model: 'AgentWorker',
  title: 'Agentiz Workers',
  icon: 'precision_manufacturing',
  navbar: {
    visible: true,
    section: 'Agentiz',
  },
})
@Table({ tableName: 'agentiz_workers', timestamps: true })
export class AgentWorker extends Model<InferAttributes<AgentWorker>, InferCreationAttributes<AgentWorker>> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @AdminizerField({ title: 'Name', required: true, views: { list: true, add: true, edit: true } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare name: string;

  @AdminizerField({
    title: 'Instance ID',
    tooltip: 'Stable id reported by the worker itself; re-registration with the same value updates this record instead of creating a second one',
    views: { list: true, add: false, edit: false },
  })
  @Column({ type: DataType.STRING, allowNull: false, unique: true })
  declare instanceId: string;

  @AdminizerField({
    title: 'Kind',
    type: 'select',
    isIn: { local: 'Local (in-process)', external: 'External' },
    views: { list: true, add: false, edit: false },
  })
  @Default('external')
  @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'external' })
  declare kind: CreationOptional<AgentWorkerKind>;

  @AdminizerField({
    title: 'Status',
    type: 'select',
    isIn: {
      pending: 'Pending approval',
      active: 'Active',
      disabled: 'Disabled',
      revoked: 'Revoked',
    },
    tooltip: 'Only "active" workers are given jobs',
    views: { list: true, add: false, edit: true },
  })
  @Default('pending')
  @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'pending' })
  declare status: CreationOptional<AgentWorkerStatus>;

  /** sha256 of the personal token. The token itself is shown once, at issue time, and never stored. */
  @Column({ type: DataType.STRING, allowNull: true, unique: true })
  declare tokenHash: string | null;

  @AdminizerField({
    title: 'Token',
    tooltip: 'Visible prefix of the personal token; the secret itself is stored only as a hash',
    views: { list: true, add: false, edit: false },
  })
  @Column({ type: DataType.STRING, allowNull: true })
  declare tokenPrefix: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare tokenIssuedAt: Date | null;

  @AdminizerField({
    title: 'Allowed projects',
    type: 'jsoneditor',
    tooltip: 'Array of AgentProject ids this worker may claim jobs for. Empty/null = every project.',
    views: { list: false, add: true, edit: true },
  })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare allowedProjectIds: string[] | null;

  @AdminizerField({
    title: 'Capabilities',
    type: 'jsoneditor',
    tooltip: '{ executors?, maxConcurrency? } reported at registration',
    views: { list: false, add: false, edit: false },
  })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare capabilities: AgentWorkerCapabilities | null;

  @AdminizerField({ title: 'Version', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare version: string | null;

  @AdminizerField({ title: 'Hostname', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare hostname: string | null;

  @AdminizerField({ title: 'Last IP', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare lastIp: string | null;

  @AdminizerField({ title: 'Last seen', type: 'datetime', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.DATE, allowNull: true })
  declare lastSeenAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastClaimAt: Date | null;

  @AdminizerField({ title: 'Claimed jobs', views: { list: true, add: false, edit: false } })
  @Default(0)
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare claimedJobsCount: CreationOptional<number>;

  @Column({ type: DataType.DATE, allowNull: true })
  declare registeredAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare approvedAt: Date | null;

  @AdminizerField({ title: 'Approved by', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare approvedBy: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare revokedAt: Date | null;

  @AdminizerField({ title: 'Revoke reason', views: { list: false, add: false, edit: true } })
  @Column({ type: DataType.TEXT, allowNull: true })
  declare revokedReason: string | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: CreationOptional<Date>;

  /** Empty/absent allowlist means "every project". */
  canClaimProject(projectId: string): boolean {
    if (!this.allowedProjectIds || this.allowedProjectIds.length === 0) return true;
    return this.allowedProjectIds.includes(projectId);
  }
}
