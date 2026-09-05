import { DataTypes } from 'sequelize';

type QI = {
  addColumn: (table: string, field: string, options: Record<string, unknown>) => Promise<unknown>;
  removeColumn: (table: string, field: string) => Promise<unknown>;
};

const SUBSCRIPTIONS = 'agentiz_harness_subscriptions';

/**
 * Result of the last window poke the worker was asked for (reset alignment, lib/harnessAlign.ts).
 * The request travels in the response of a usage report, so without this column the server has no
 * way of knowing whether it was carried out — a failing poke was visible only in the worker's
 * journal.
 */
export async function up({ context }: { context: QI }) {
  await context.addColumn(SUBSCRIPTIONS, 'lastPoke', { type: DataTypes.JSONB, allowNull: true });
}

export async function down({ context }: { context: QI }) {
  await context.removeColumn(SUBSCRIPTIONS, 'lastPoke');
}
