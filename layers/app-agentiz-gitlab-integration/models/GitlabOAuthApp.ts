import { Table, Column, Model, DataType, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import type { GitlabOAuthAppSecrets } from '../types/gitlab';

/**
 * An OAuth "Application" registered inside a GitLab instance (User/Group/Admin -> Applications).
 * One row per GitLab instance we integrate with — gitlab.com and any number of self-hosted ones.
 */
@AdminizerModel({
  model: 'GitlabOAuthApp',
  title: 'GitLab OAuth Apps',
  icon: 'key',
  navbar: {
    visible: true,
    section: 'Agentiz',
  },
})
@Table({ tableName: 'agentiz_gitlab_oauth_apps', timestamps: true })
export class GitlabOAuthApp extends Model<InferAttributes<GitlabOAuthApp>, InferCreationAttributes<GitlabOAuthApp>> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @AdminizerField({ title: 'Name', required: true, views: { list: true, add: true, edit: true } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare name: string;

  @AdminizerField({
    title: 'GitLab URL',
    required: true,
    tooltip: 'Instance root, e.g. https://gitlab.com or https://git.company.tld',
    views: { list: true, add: true, edit: true },
  })
  @Column({ type: DataType.STRING, allowNull: false })
  declare baseUrl: string;

  @AdminizerField({ title: 'Application ID', required: true, views: { list: true, add: true, edit: true } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare applicationId: string;

  @AdminizerField({
    title: 'Secrets',
    type: 'jsoneditor',
    tooltip: '{ clientSecret } - masked in the UI',
    views: { list: false, add: true, edit: true },
    groupsAccessRights: ['admin'],
  })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare secrets: GitlabOAuthAppSecrets | null;

  @AdminizerField({
    title: 'Redirect URI',
    tooltip: 'Must match the redirect URI registered in GitLab. Empty = derived from the request host.',
    views: { list: false, add: true, edit: true },
  })
  @Column({ type: DataType.STRING, allowNull: true })
  declare redirectUri: string | null;

  @AdminizerField({ title: 'Scopes', type: 'jsoneditor', views: { list: false, add: true, edit: true } })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare scopes: string[] | null;

  @AdminizerField({ title: 'Active', type: 'boolean', views: { list: true, add: true, edit: true } })
  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare isActive: boolean;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: CreationOptional<Date>;

  // No association to the connections it authorized: they are core rows (AgentGitConnection) and
  // reference this application by an opaque string, so the core never joins through this layer.
}
