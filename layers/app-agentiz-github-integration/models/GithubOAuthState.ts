import { Table, Column, Model, DataType, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerModel } from '@nodeknit/app-adminizer';

/**
 * Short-lived CSRF `state` of an authorization request in flight. Persisted rather than kept in
 * memory so the callback also lands correctly after a restart or with more than one process.
 *
 * **No `codeVerifier` here, unlike GitlabOAuthState.** Classic GitHub OAuth Apps do not support
 * PKCE — the parameters are simply ignored — so the flow is protected by this single-use state
 * plus the client secret at exchange time. Adding a verifier "for symmetry" would only pretend to
 * do something.
 */
@AdminizerModel({
  model: 'GithubOAuthState',
  title: 'GitHub OAuth States',
  icon: 'pending',
  navbar: { visible: false },
})
@Table({ tableName: 'agentiz_github_oauth_states', timestamps: true })
export class GithubOAuthState extends Model<InferAttributes<GithubOAuthState>, InferCreationAttributes<GithubOAuthState>> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @Column({ type: DataType.STRING, allowNull: false, unique: true })
  declare state: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare oauthAppId: string;

  /** Exactly the redirect_uri sent to GitHub — the token request must repeat it verbatim. */
  @Column({ type: DataType.STRING, allowNull: false })
  declare redirectUri: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare returnTo: string | null;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare ownerId: number | null;

  @Column({ type: DataType.DATE, allowNull: false })
  declare expiresAt: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  declare usedAt: Date | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: CreationOptional<Date>;
}
