import { Table, Column, Model, DataType, BelongsTo, HasMany, ForeignKey, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { GitlabConnection } from './GitlabConnection';
import { AgentProjectIntegration } from './AgentProjectIntegration';

/**
 * Local mirror of a GitLab project (repository) reachable through a connection. Refreshed by
 * GitlabRepositorySyncService so the UI can offer a pick list without hitting the GitLab API
 * on every render.
 */
@AdminizerModel({
  model: 'GitlabRepository',
  title: 'GitLab Repositories',
  icon: 'folder_copy',
  navbar: {
    visible: true,
    section: 'Agentiz',
  },
})
@Table({ tableName: 'agentiz_gitlab_repositories', timestamps: true })
export class GitlabRepository extends Model<InferAttributes<GitlabRepository>, InferCreationAttributes<GitlabRepository>> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @ForeignKey(() => GitlabConnection)
  @AdminizerField({ title: 'Connection', required: true, views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare connectionId: string;

  @AdminizerField({ title: 'GitLab project id', required: true, views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare gitlabProjectId: number;

  @AdminizerField({ title: 'Path', required: true, views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare pathWithNamespace: string;

  @AdminizerField({ title: 'Name', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare name: string | null;

  @AdminizerField({ title: 'Web URL', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare webUrl: string | null;

  @AdminizerField({ title: 'Default branch', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare defaultBranch: string | null;

  @AdminizerField({ title: 'Visibility', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare visibility: string | null;

  @AdminizerField({ title: 'Description', type: 'longtext', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  @AdminizerField({ title: 'Issues enabled', type: 'boolean', views: { list: true, add: false, edit: false } })
  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare issuesEnabled: boolean;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastActivityAt: Date | null;

  @AdminizerField({ title: 'Raw payload', type: 'jsoneditor', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare raw: Record<string, unknown> | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: CreationOptional<Date>;

  @BelongsTo(() => GitlabConnection, 'connectionId')
  declare connection: GitlabConnection;

  @HasMany(() => AgentProjectIntegration, 'repositoryId')
  declare integrations: AgentProjectIntegration[];
}
