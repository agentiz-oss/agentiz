import { Table, Column, Model, DataType, BelongsTo, HasMany, ForeignKey, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentGitConnection } from './AgentGitConnection';
import { AgentProjectRepository } from './AgentProjectRepository';
import type { GitProviderType } from '../types/agentiz';

/**
 * Local mirror of a repository reachable through a connection, refreshed by the provider layer so
 * that linking one to a project is a local pick rather than an API call per render.
 *
 * Both `pathWithNamespace` and the split `owner`/`repo` are kept: splitting is lossy (GitLab allows
 * nested groups, so `owner` may itself contain slashes) and the two REST clients want different
 * forms. `cloneUrl` is stored as the platform reports it instead of being assembled from a host and
 * a path — self-hosted installations do not always follow that shape.
 */
@AdminizerModel({
  model: 'AgentRepository',
  title: 'Repositories',
  icon: 'folder_copy',
  navbar: {
    visible: true,
    section: 'Agentiz',
  },
})
@Table({ tableName: 'agentiz_repositories', timestamps: true })
export class AgentRepository extends Model<
  InferAttributes<AgentRepository>,
  InferCreationAttributes<AgentRepository>
> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @ForeignKey(() => AgentGitConnection)
  @AdminizerField({ title: 'Connection', required: true, views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare connectionId: string;

  /** Denormalized from the connection: most queries filter by platform and never need the join. */
  @AdminizerField({
    title: 'Provider',
    type: 'select',
    isIn: { github: 'GitHub', gitlab: 'GitLab' },
    views: { list: true, add: false, edit: false },
  })
  @Column({ type: DataType.STRING, allowNull: false })
  declare provider: GitProviderType;

  /** String: GitLab numbers projects, GitHub numbers repositories, and the types differ. */
  @AdminizerField({ title: 'External id', required: true, views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare externalRepoId: string;

  @AdminizerField({ title: 'Path', required: true, views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare pathWithNamespace: string;

  @AdminizerField({ title: 'Owner', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false, defaultValue: '' })
  declare owner: string;

  @AdminizerField({ title: 'Repo', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false, defaultValue: '' })
  declare repo: string;

  @AdminizerField({ title: 'Name', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare name: string | null;

  @AdminizerField({ title: 'Web URL', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare webUrl: string | null;

  @AdminizerField({ title: 'Clone URL', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare cloneUrl: string | null;

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
  declare issuesEnabled: CreationOptional<boolean>;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastActivityAt: Date | null;

  @AdminizerField({ title: 'Raw payload', type: 'jsoneditor', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare raw: Record<string, unknown> | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: CreationOptional<Date>;

  @BelongsTo(() => AgentGitConnection, 'connectionId')
  declare connection: AgentGitConnection;

  @HasMany(() => AgentProjectRepository, 'repositoryId')
  declare links: AgentProjectRepository[];
}
