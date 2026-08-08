import { Table, Column, Model, DataType, HasMany, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentRepository } from './AgentRepository';
import type { GitConnectionSecrets, GitConnectionStatus, GitProviderType } from '../types/agentiz';

/**
 * One authorized account at one hosting platform — the access/refresh token pair plus who it
 * belongs to. Everything Agentiz reads from a platform on a user's behalf goes through a
 * connection, and a project may use several at once (different accounts, different instances).
 *
 * The model is deliberately platform-neutral and lives in the core: a repository id has to mean the
 * same thing everywhere (runner allowlists, job snapshots, stored diffs), which two per-layer id
 * spaces could not provide.
 *
 * `oauthAppId` is an opaque string, **not** a foreign key. The OAuth application itself (client
 * id/secret, redirect, scope dialect) is unavoidably platform-specific and stays in its layer; the
 * core never joins through it. When a live token is needed, the connection goes back to the layer
 * through `GitConnectionAuthority` (see lib/git/connections.ts). `baseUrl` is denormalized here for
 * the same reason — clone URLs and API bases must be buildable without reading a layer's table.
 */
@AdminizerModel({
  model: 'AgentGitConnection',
  title: 'Git Connections',
  icon: 'link',
  navbar: {
    visible: true,
    section: 'Agentiz',
  },
})
@Table({ tableName: 'agentiz_git_connections', timestamps: true })
export class AgentGitConnection extends Model<
  InferAttributes<AgentGitConnection>,
  InferCreationAttributes<AgentGitConnection>
> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @AdminizerField({
    title: 'Provider',
    type: 'select',
    isIn: { github: 'GitHub', gitlab: 'GitLab' },
    required: true,
    views: { list: true, add: false, edit: false },
  })
  @Column({ type: DataType.STRING, allowNull: false })
  declare provider: GitProviderType;

  @AdminizerField({
    title: 'OAuth App',
    tooltip: 'Row id of the OAuth application in the provider layer. Opaque to the core.',
    views: { list: false, add: false, edit: false },
  })
  @Column({ type: DataType.STRING, allowNull: true })
  declare oauthAppId: string | null;

  @AdminizerField({
    title: 'Instance',
    tooltip: 'https://gitlab.com, a self-hosted GitLab, github.com or GitHub Enterprise',
    views: { list: true, add: false, edit: false },
  })
  @Column({ type: DataType.STRING, allowNull: true })
  declare baseUrl: string | null;

  /** String, because platforms disagree on the type of their own user ids. */
  @AdminizerField({ title: 'External user id', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare externalUserId: string | null;

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
  declare secrets: GitConnectionSecrets | null;

  @AdminizerField({ title: 'Granted scopes', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare scope: string | null;

  /** null = the token has no expiry at all, which is the normal case for a GitHub OAuth App. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare expiresAt: Date | null;

  /**
   * STRING rather than a postgres ENUM on purpose: adding a value to an ENUM needs its own
   * `ALTER TYPE ... ADD VALUE`, which sqlite does not support at all — this project runs on both.
   */
  @AdminizerField({
    title: 'Status',
    type: 'select',
    isIn: { active: 'Active', expired: 'Expired', revoked: 'Revoked', error: 'Error' },
    views: { list: true, add: false, edit: true },
  })
  @Default('active')
  @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'active' })
  declare status: CreationOptional<GitConnectionStatus>;

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

  @HasMany(() => AgentRepository, 'connectionId')
  declare repositories: AgentRepository[];
}
