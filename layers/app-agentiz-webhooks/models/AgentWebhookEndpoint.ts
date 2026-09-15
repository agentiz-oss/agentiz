import { Table, Column, Model, DataType, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';

/**
 * One public URL somebody outside sends deliveries to.
 *
 * The id **is** the URL (`/api/agentiz/hooks/v1/:id`) and that is not a secret in a query string:
 * the id is what tells us, before the body is parsed, which mapper this is and whose secret the
 * signature has to be checked against — a signature cannot be verified without knowing that first.
 * Whoever can already sign a delivery gains nothing from knowing the id.
 *
 * `ownerKey` is what makes creation idempotent: a provider layer asks for "the endpoint of
 * `repository:<id>`" and gets the same row every time, so re-linking a repository does not
 * accumulate endpoints and removing the link has something to delete by name.
 *
 * `secretHash` is only used when the mapper says `auth: 'endpoint'`. The repository-webhook mapper
 * does not: its secret was issued by us *to* GitHub, per repository, and lives on
 * `AgentRepository.webhook` — see `WebhookMapper.auth` in the core.
 */
@AdminizerModel({
  model: 'AgentWebhookEndpoint',
  title: 'Webhook endpoints',
  icon: 'webhook',
  navbar: { visible: true, section: 'Agentiz' },
})
@Table({ tableName: 'agentiz_webhook_endpoints', timestamps: true })
export class AgentWebhookEndpoint extends Model<
  InferAttributes<AgentWebhookEndpoint>,
  InferCreationAttributes<AgentWebhookEndpoint>
> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  /** Which mapper decodes deliveries here — the key of the `webhookMappers` registry. */
  @AdminizerField({ title: 'Kind', required: true, views: { list: true, add: true, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare kind: string;

  /** Stable name of whatever this endpoint belongs to, e.g. `repository:<AgentRepository.id>`. */
  @AdminizerField({ title: 'Owner', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false, unique: true })
  declare ownerKey: string;

  /** Null when the endpoint serves something that is not one project's (a shared repository). */
  @AdminizerField({ title: 'Project', views: { list: true, add: true, edit: true } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare projectId: string | null;

  @AdminizerField({ title: 'Config', type: 'jsoneditor', views: { list: false, add: true, edit: true } })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare config: Record<string, unknown> | null;

  /** sha256 of the bearer/HMAC secret, for mappers whose sender authenticates against the endpoint. */
  @Column({ type: DataType.STRING, allowNull: true })
  declare secretHash: string | null;

  @AdminizerField({ title: 'Active', type: 'boolean', views: { list: true, add: true, edit: true } })
  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare isActive: CreationOptional<boolean>;

  @AdminizerField({ title: 'Last delivery', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.DATE, allowNull: true })
  declare lastDeliveryAt: Date | null;

  @Default(0)
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare deliveryCount: CreationOptional<number>;

  @AdminizerField({ title: 'Last error', type: 'longtext', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.TEXT, allowNull: true })
  declare lastError: string | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: CreationOptional<Date>;
}
