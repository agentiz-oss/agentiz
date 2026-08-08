import { Table, Column, Model, DataType, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import type { GithubOAuthAppSecrets } from '../types/github';

/**
 * An OAuth App registered in GitHub (Settings -> Developer settings -> OAuth Apps) or in a GitHub
 * Enterprise instance. One row per instance we integrate with.
 */
@AdminizerModel({
  model: 'GithubOAuthApp',
  title: 'GitHub OAuth Apps',
  icon: 'key',
  navbar: {
    visible: true,
    section: 'Agentiz',
  },
})
@Table({ tableName: 'agentiz_github_oauth_apps', timestamps: true })
export class GithubOAuthApp extends Model<InferAttributes<GithubOAuthApp>, InferCreationAttributes<GithubOAuthApp>> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @AdminizerField({ title: 'Name', required: true, views: { list: true, add: true, edit: true } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare name: string;

  /** Site root, not the API root — see `apiBaseFor` in ../types/github.ts. */
  @AdminizerField({
    title: 'GitHub URL',
    required: true,
    tooltip: 'Site root: https://github.com or the root of a GitHub Enterprise instance',
    views: { list: true, add: true, edit: true },
  })
  @Column({ type: DataType.STRING, allowNull: false })
  declare baseUrl: string;

  @AdminizerField({ title: 'Client ID', required: true, views: { list: true, add: true, edit: true } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare clientId: string;

  @AdminizerField({
    title: 'Secrets',
    type: 'jsoneditor',
    tooltip: '{ clientSecret } - masked in the UI',
    views: { list: false, add: true, edit: true },
    groupsAccessRights: ['admin'],
  })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare secrets: GithubOAuthAppSecrets | null;

  @AdminizerField({
    title: 'Redirect URI',
    tooltip: 'Must match the callback URL registered in GitHub. Empty = derived from the request host.',
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
}
