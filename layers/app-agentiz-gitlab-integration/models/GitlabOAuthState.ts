import { Table, Column, Model, DataType, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerModel } from '@nodeknit/app-adminizer';

/**
 * Short-lived CSRF `state` + PKCE verifier of an authorization request in flight.
 * Persisted rather than kept in memory so the callback also lands correctly when the server was
 * restarted or is running more than one process.
 */
@AdminizerModel({
  model: 'GitlabOAuthState',
  title: 'GitLab OAuth States',
  icon: 'pending',
  navbar: { visible: false },
})
@Table({ tableName: 'agentiz_gitlab_oauth_states', timestamps: true })
export class GitlabOAuthState extends Model<InferAttributes<GitlabOAuthState>, InferCreationAttributes<GitlabOAuthState>> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @Column({ type: DataType.STRING, allowNull: false, unique: true })
  declare state: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare oauthAppId: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare codeVerifier: string;

  /** Exactly the redirect_uri sent to GitLab — the token request must repeat it verbatim. */
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
