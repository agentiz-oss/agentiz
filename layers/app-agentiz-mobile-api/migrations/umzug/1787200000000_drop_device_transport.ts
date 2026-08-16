import { DataTypes } from 'sequelize';

type QI = {
  sequelize: {
    getDialect: () => string;
    query: (sql: string) => Promise<unknown>;
  };
  addColumn: (table: string, column: string, attrs: Record<string, unknown>) => Promise<unknown>;
  removeColumn: (table: string, column: string) => Promise<unknown>;
};

const TABLE = 'agentiz_mobile_devices';
const COLUMN = 'transport';

/**
 * Drops the per-device transport.
 *
 * It existed to tell an FCM registration token from a raw APNs one, back when iOS talked to Apple
 * directly. iOS now carries the Firebase SDK and registers an FCM token like Android, so every row
 * would hold the same value — a column that cannot differ is not a fact about a device.
 *
 * Rows are left alone: any token still stored is an FCM one, and a device that somehow held an
 * Apple token would simply be reported gone by FCM and deleted on the first push.
 */
export async function up({ context }: { context: QI }) {
  await context.removeColumn(TABLE, COLUMN);
  // Postgres keeps the enum type behind after its only column is gone.
  if (context.sequelize.getDialect() === 'postgres') {
    await context.sequelize.query(`DROP TYPE IF EXISTS "enum_${TABLE}_${COLUMN}"`);
  }
}

export async function down({ context }: { context: QI }) {
  // Restored as it was, with the value every surviving row would have had.
  await context.addColumn(TABLE, COLUMN, {
    type: DataTypes.ENUM('fcm', 'apns'),
    allowNull: false,
    defaultValue: 'fcm',
  });
}
