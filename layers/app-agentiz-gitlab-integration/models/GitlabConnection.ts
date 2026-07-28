import { Table, Column, Model, DataType, BelongsTo, HasMany, ForeignKey, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { GitlabOAuthApp } from './GitlabOAuthApp';
import { GitlabRepository } from './GitlabRepository';
import type { GitlabConnectionSecrets, GitlabConnectionStatus } from '../types/gitlab';

/**
 * One GitLab identity authorized through an OAuth app: the access/refresh token pair plus who it
 * belongs to. Everything this layer reads from GitLab goes through a connection, and a single
 * Agentiz project may use several of them (different accounts, different instances).
 */
@AdminizerModel({
  model: 'GitlabConnection',
  title: 'GitLab Connections',
  icon: 'link',
  navbar: {
    visible: true,
    section: 'Agentiz',
  },
})
@Table({ tableName: 'agentiz_gitlab_connections', timestamps: true })
export class GitlabConnection extends Model<InferAttributes<GitlabConnection>, InferCreationAttributes<GitlabConnection>> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @ForeignKey(() => GitlabOAuthApp)
  @AdminizerField({ title: 'OAuth App', required: true, views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare oauthAppId: string;

  @AdminizerField({ title: 'GitLab user id', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare gitlabUserId: number | null;

  @AdminizerField({ title: 'Username', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare username: string | null;

  @AdminizerField({ title: 'Name', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare displayName: string | null;

  @AdminizerField({ title: 'Avatar', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare avatarUrl: string | null;

  @AdminizerField({
    title: 'Secrets',
    type: 'jsoneditor',
    tooltip: '{ accessToken, refreshToken } - masked in the UI',
    views: { list: false, add: false, edit: false },
    groupsAccessRights: ['admin'],
  })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare secrets: GitlabConnectionSecrets | null;

  @AdminizerField({ title: 'Granted scopes', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare scope: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare expiresAt: Date | null;

  @AdminizerField({
    title: 'Status',
    type: 'select',
    isIn: { active: 'Active', expired: 'Expired', revoked: 'Revoked', error: 'Error' },
    views: { list: true, add: false, edit: true },
  })
  @Default('active')
  @Column({
    type: DataType.ENUM('active', 'expired', 'revoked', 'error'),
    allowNull: false,
    defaultValue: 'active',
  })
  declare status: GitlabConnectionStatus;

  @AdminizerField({ title: 'Last error', type: 'longtext', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.TEXT, allowNull: true })
  declare lastError: string | null;

  /** Adminizer user who performed the authorization. */
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare ownerId: number | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastSyncedAt: Date | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: CreationOptional<Date>;

  @BelongsTo(() => GitlabOAuthApp, 'oauthAppId')
  declare oauthApp: GitlabOAuthApp;

  @HasMany(() => GitlabRepository, 'connectionId')
  declare repositories: GitlabRepository[];
}
