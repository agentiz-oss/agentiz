import { DataTypes } from 'sequelize';

type QI = {
  createTable: (name: string, attrs: Record<string, unknown>) => Promise<unknown>;
  dropTable: (name: string) => Promise<unknown>;
};

const TABLE = 'agentiz_mobile_push_settings';

export async function up({ context }: { context: QI }) {
  await context.createTable(TABLE, {
    // The key is the environment-variable name, so it is already unique and already the identity —
    // a surrogate id would only allow two rows to disagree about one setting.
    key: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    value: { type: DataTypes.TEXT, allowNull: false },
    updatedBy: { type: DataTypes.STRING, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });
}

export async function down({ context }: { context: QI }) {
  await context.dropTable(TABLE);
}
