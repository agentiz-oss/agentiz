import { DataTypes } from 'sequelize';

type QI = {
  sequelize: { getDialect: () => string };
  createTable: (name: string, attrs: Record<string, unknown>) => Promise<unknown>;
  addIndex: (table: string, fields: string[], options?: Record<string, unknown>) => Promise<unknown>;
  dropTable: (name: string) => Promise<unknown>;
};

function jsonType(context: QI) {
  return context.sequelize.getDialect() === 'postgres' ? DataTypes.JSONB : DataTypes.JSON;
}

export async function up({ context }: { context: QI }) {
  const json = jsonType(context);

  await context.createTable('agentiz_workers', {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    name: { type: DataTypes.STRING, allowNull: false },
    instanceId: { type: DataTypes.STRING, allowNull: false, unique: true },
    kind: { type: DataTypes.STRING, allowNull: false, defaultValue: 'external' },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'pending' },
    tokenHash: { type: DataTypes.STRING, allowNull: true, unique: true },
    tokenPrefix: { type: DataTypes.STRING, allowNull: true },
    tokenIssuedAt: { type: DataTypes.DATE, allowNull: true },
    allowedProjectIds: { type: json, allowNull: true },
    capabilities: { type: json, allowNull: true },
    version: { type: DataTypes.STRING, allowNull: true },
    hostname: { type: DataTypes.STRING, allowNull: true },
    lastIp: { type: DataTypes.STRING, allowNull: true },
    lastSeenAt: { type: DataTypes.DATE, allowNull: true },
    lastClaimAt: { type: DataTypes.DATE, allowNull: true },
    claimedJobsCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    registeredAt: { type: DataTypes.DATE, allowNull: true },
    approvedAt: { type: DataTypes.DATE, allowNull: true },
    approvedBy: { type: DataTypes.STRING, allowNull: true },
    revokedAt: { type: DataTypes.DATE, allowNull: true },
    revokedReason: { type: DataTypes.TEXT, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });

  await context.addIndex('agentiz_workers', ['status'], {
    name: 'agentiz_workers_status_idx',
  });
}

export async function down({ context }: { context: QI }) {
  await context.dropTable('agentiz_workers');
}
