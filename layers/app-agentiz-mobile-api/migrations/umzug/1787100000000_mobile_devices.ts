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

const TABLE = 'agentiz_mobile_devices';

export async function up({ context }: { context: QI }) {
  await context.createTable(TABLE, {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    platform: { type: DataTypes.ENUM('android', 'ios'), allowNull: false },
    transport: { type: DataTypes.ENUM('fcm', 'apns'), allowNull: false },
    token: { type: DataTypes.TEXT, allowNull: false },
    appVersion: { type: DataTypes.STRING, allowNull: true },
    deviceName: { type: DataTypes.STRING, allowNull: true },
    lastSeenAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });
  // The token is the address, so it can only belong to one row: a device handed to another user
  // must stop receiving the first user's questions the moment it registers again.
  await context.addIndex(TABLE, ['token'], { unique: true, name: 'agentiz_mobile_devices_token_unique' });
  await context.addIndex(TABLE, ['userId'], { name: 'agentiz_mobile_devices_user' });
}

export async function down({ context }: { context: QI }) {
  await context.dropTable(TABLE);
}
