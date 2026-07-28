import { Table, Column, Model, DataType, BelongsTo, ForeignKey, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { GitlabConnection } from './GitlabConnection';
import { GitlabRepository } from './GitlabRepository';
import type { AgentProjectIntegrationConfig, IntegrationRole } from '../types/gitlab';

/**
 * The link the whole layer exists for: an Agentiz project <-> one external repository.
 *
 * It is a plain many-to-many row, so a project can carry any number of links at once — several
 * repositories of the same GitLab instance, repositories from different instances, and (once other
 * integration layers appear) different external systems, distinguished by `provider`.
 */
@AdminizerModel({
  model: 'AgentProjectIntegration',
  title: 'Project Integrations',
  icon: 'hub',
  navbar: {
    visible: true,
    section: 'Agentiz',
  },
})
@Table({ tableName: 'agentiz_project_integrations', timestamps: true })
export class AgentProjectIntegration extends Model<
  InferAttributes<AgentProjectIntegration>,
  InferCreationAttributes<AgentProjectIntegration>
> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @ForeignKey(() => AgentProject)
  @AdminizerField({ title: 'Agentiz project', required: true, views: { list: true, add: true, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare projectId: string;

  /** Kept generic on purpose: future layers register their own value here. */
  @AdminizerField({ title: 'Provider', views: { list: true, add: false, edit: false } })
  @Default('gitlab')
  @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'gitlab' })
  declare provider: string;

  @ForeignKey(() => GitlabConnection)
  @AdminizerField({ title: 'Connection', required: true, views: { list: true, add: true, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare connectionId: string;

  @ForeignKey(() => GitlabRepository)
  @AdminizerField({ title: 'Repository', required: true, views: { list: true, add: true, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare repositoryId: string;

  @AdminizerField({
    title: 'Role',
    type: 'select',
    isIn: { source: 'Issue source', target: 'Commit target', both: 'Source and target' },
    views: { list: true, add: true, edit: true },
  })
  @Default('both')
  @Column({ type: DataType.ENUM('source', 'target', 'both'), allowNull: false, defaultValue: 'both' })
  declare role: IntegrationRole;

  @AdminizerField({
    title: 'Primary',
    type: 'boolean',
    tooltip: 'Repository used when a task carries no repository of its own',
    views: { list: true, add: true, edit: true },
  })
  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare isPrimary: boolean;

  @AdminizerField({ title: 'Sync issues', type: 'boolean', views: { list: true, add: true, edit: true } })
  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare syncIssues: boolean;

  @AdminizerField({ title: 'Active', type: 'boolean', views: { list: true, add: true, edit: true } })
  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare isActive: boolean;

  @AdminizerField({
    title: 'Config',
    type: 'jsoneditor',
    tooltip: '{ pollIntervalSec?, query?, defaultBranch? }',
    views: { list: false, add: true, edit: true },
  })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare config: AgentProjectIntegrationConfig | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastSyncedAt: Date | null;

  @AdminizerField({ title: 'Last error', type: 'longtext', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.TEXT, allowNull: true })
  declare lastError: string | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: CreationOptional<Date>;

  @BelongsTo(() => AgentProject, 'projectId')
  declare project: AgentProject;

  @BelongsTo(() => GitlabConnection, 'connectionId')
  declare connection: GitlabConnection;

  @BelongsTo(() => GitlabRepository, 'repositoryId')
  declare repository: GitlabRepository;
}
