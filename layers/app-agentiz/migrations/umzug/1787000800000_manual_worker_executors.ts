import { DataTypes } from 'sequelize';

type QI = {
  sequelize: { getDialect: () => string };
  addColumn: (table: string, column: string, attributes: Record<string, unknown>) => Promise<unknown>;
  removeColumn: (table: string, column: string) => Promise<unknown>;
};

function jsonType(context: QI) {
  return context.sequelize.getDialect() === 'postgres' ? DataTypes.JSONB : DataTypes.JSON;
}

/** Named ACP profiles are deliberately worker-owned: a manual run may only select a configured profile. */
export async function up({ context }: { context: QI }) {
  await context.addColumn('agentiz_workers', 'manualExecutors', { type: jsonType(context), allowNull: true });
  await context.addColumn('agentiz_runs', 'executorOverride', { type: jsonType(context), allowNull: true });
}

export async function down({ context }: { context: QI }) {
  await context.removeColumn('agentiz_runs', 'executorOverride');
  await context.removeColumn('agentiz_workers', 'manualExecutors');
}
