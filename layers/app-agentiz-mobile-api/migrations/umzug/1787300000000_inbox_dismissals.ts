import { DataTypes } from 'sequelize';

type QI = {
  sequelize: {
    getDialect: () => string;
    query: (sql: string) => Promise<unknown>;
  };
  createTable: (name: string, attrs: Record<string, unknown>) => Promise<unknown>;
  addIndex: (table: string, fields: string[], options?: Record<string, unknown>) => Promise<unknown>;
  dropTable: (name: string) => Promise<unknown>;
};

const TABLE = 'agentiz_mobile_inbox_dismissals';

export async function up({ context }: { context: QI }) {
  await context.createTable(TABLE, {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    itemId: { type: DataTypes.STRING, allowNull: false },
    projectId: { type: DataTypes.STRING, allowNull: true },
    taskId: { type: DataTypes.STRING, allowNull: true },
    runId: { type: DataTypes.STRING, allowNull: true },
    activityType: { type: DataTypes.STRING, allowNull: true },
    dismissedAt: { type: DataTypes.DATE, allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });
  // One decision per person per row: dismissing twice is the same statement, and the read path
  // looks a row up by exactly this pair.
  await context.addIndex(TABLE, ['userId', 'itemId'], {
    unique: true,
    name: 'agentiz_mobile_inbox_dismissals_user_item',
  });
}

export async function down({ context }: { context: QI }) {
  await context.dropTable(TABLE);
}
