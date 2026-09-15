import { DataTypes } from 'sequelize';

/**
 * Two tables: the endpoints somebody sends to, and the journal of what arrived.
 *
 * `createTable` only — no `changeColumn`/`removeColumn` anywhere in this layer's history, so the
 * sqlite table-rebuild hazard described in AGENTS.md cannot apply to it. The composite unique index
 * on (endpointId, dedupeKey) is created explicitly rather than declared inline for the same reason:
 * it must stay a *table* index, not a column flag.
 */
type QI = {
  sequelize: { getDialect: () => string };
  createTable: (name: string, attrs: Record<string, unknown>) => Promise<unknown>;
  addIndex: (table: string, fields: string[], options?: Record<string, unknown>) => Promise<unknown>;
  dropTable: (name: string) => Promise<unknown>;
};

const ENDPOINTS = 'agentiz_webhook_endpoints';
const DELIVERIES = 'agentiz_webhook_deliveries';

export async function up({ context }: { context: QI }) {
  const json = context.sequelize.getDialect() === 'postgres' ? DataTypes.JSONB : DataTypes.JSON;

  await context.createTable(ENDPOINTS, {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    kind: { type: DataTypes.STRING, allowNull: false },
    ownerKey: { type: DataTypes.STRING, allowNull: false, unique: true },
    projectId: { type: DataTypes.STRING, allowNull: true },
    config: { type: json, allowNull: true },
    secretHash: { type: DataTypes.STRING, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    lastDeliveryAt: { type: DataTypes.DATE, allowNull: true },
    deliveryCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    lastError: { type: DataTypes.TEXT, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });

  await context.createTable(DELIVERIES, {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    endpointId: { type: DataTypes.STRING, allowNull: false },
    outcome: { type: DataTypes.STRING, allowNull: false },
    dedupeKey: { type: DataTypes.STRING, allowNull: true },
    eventName: { type: DataTypes.STRING, allowNull: true },
    httpStatus: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 200 },
    detail: { type: DataTypes.TEXT, allowNull: true },
    payloadExcerpt: { type: DataTypes.TEXT, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });

  // What makes a re-delivery a duplicate rather than a second event. Per endpoint, because two
  // senders can perfectly well number their deliveries from the same counter.
  await context.addIndex(DELIVERIES, ['endpointId', 'dedupeKey'], {
    name: 'agentiz_webhook_deliveries_endpoint_dedupe',
    unique: true,
  });
  await context.addIndex(DELIVERIES, ['endpointId', 'createdAt'], {
    name: 'agentiz_webhook_deliveries_endpoint_created',
  });
}

export async function down({ context }: { context: QI }) {
  await context.dropTable(DELIVERIES);
  await context.dropTable(ENDPOINTS);
}
