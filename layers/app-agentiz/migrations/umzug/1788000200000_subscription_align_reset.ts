import { DataTypes } from 'sequelize';

type QI = {
  addColumn: (table: string, field: string, options: Record<string, unknown>) => Promise<unknown>;
  removeColumn: (table: string, field: string) => Promise<unknown>;
};

const SUBSCRIPTIONS = 'agentiz_harness_subscriptions';

/**
 * Daily reset alignment for a subscription (см. lib/harnessAlign.ts): the operator picks an hour
 * and a timezone, and the claim gate + worker poke arrange for the session window's reset to land
 * on that hour. Best-effort — the fields configure discipline, they enforce nothing by themselves.
 */
export async function up({ context }: { context: QI }) {
  await context.addColumn(SUBSCRIPTIONS, 'alignResetEnabled', {
    type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false,
  });
  await context.addColumn(SUBSCRIPTIONS, 'alignResetHour', { type: DataTypes.INTEGER, allowNull: true });
  await context.addColumn(SUBSCRIPTIONS, 'alignResetTimezone', { type: DataTypes.STRING, allowNull: true });
}

export async function down({ context }: { context: QI }) {
  await context.removeColumn(SUBSCRIPTIONS, 'alignResetTimezone');
  await context.removeColumn(SUBSCRIPTIONS, 'alignResetHour');
  await context.removeColumn(SUBSCRIPTIONS, 'alignResetEnabled');
}
