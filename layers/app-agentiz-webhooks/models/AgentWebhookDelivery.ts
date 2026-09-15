import { Table, Column, Model, DataType, Default, ForeignKey, BelongsTo } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentWebhookEndpoint } from './AgentWebhookEndpoint';

/**
 * One delivery, written **always** — including the ones we rejected and the ones we deliberately
 * ignored.
 *
 * Same reason `ActivityService.record()` writes the feed row before consulting any policy: "мы
 * отправили, у вас пусто" is a claim that can only be settled by a journal, and a journal that
 * skips uninteresting deliveries answers exactly the question nobody asks. GitHub sends ten event
 * types where we watch two, so most rows here are `ignored` and that is the healthy state.
 */
@AdminizerModel({
  model: 'AgentWebhookDelivery',
  title: 'Webhook deliveries',
  icon: 'call_received',
  navbar: { visible: true, section: 'Agentiz' },
})
@Table({
  tableName: 'agentiz_webhook_deliveries',
  timestamps: true,
  // Declared on the model as well as in the migration, and it must stay so: `sync({ alter: true })`
  // is the schema mechanism for a DATABASE_URL setup, and an index that exists only in the
  // migration would make deduplication work in production and silently not work in development —
  // where a re-delivery would then publish a second event.
  indexes: [
    { name: 'agentiz_webhook_deliveries_endpoint_dedupe', unique: true, fields: ['endpointId', 'dedupeKey'] },
    { name: 'agentiz_webhook_deliveries_endpoint_created', fields: ['endpointId', 'createdAt'] },
  ],
})
export class AgentWebhookDelivery extends Model<
  InferAttributes<AgentWebhookDelivery>,
  InferCreationAttributes<AgentWebhookDelivery>
> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @ForeignKey(() => AgentWebhookEndpoint)
  @AdminizerField({ title: 'Endpoint', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare endpointId: string;

  /** `accepted` | `ignored` | `duplicate` | `rejected`. */
  @AdminizerField({ title: 'Outcome', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare outcome: string;

  /**
   * The sender's own delivery id (`X-GitHub-Delivery`, `Idempotency-Key`), when it provides one.
   *
   * Indexed and unique per endpoint: this is what makes a re-delivery a `duplicate` answered 200
   * instead of a second event. A sender that provides none simply cannot be deduplicated, which is
   * why the poll is the safety net and not the other way round.
   */
  @Column({ type: DataType.STRING, allowNull: true })
  declare dedupeKey: string | null;

  @AdminizerField({ title: 'Event', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare eventName: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 200 })
  declare httpStatus: CreationOptional<number>;

  @AdminizerField({ title: 'Detail', type: 'longtext', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.TEXT, allowNull: true })
  declare detail: string | null;

  /** Truncated body, so a payload that made no sense can be read back without keeping megabytes. */
  @AdminizerField({ title: 'Payload', type: 'longtext', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.TEXT, allowNull: true })
  declare payloadExcerpt: string | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: CreationOptional<Date>;

  @BelongsTo(() => AgentWebhookEndpoint, 'endpointId')
  declare endpoint: AgentWebhookEndpoint;
}
