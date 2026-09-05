import { DataTypes } from 'sequelize';

type QI = {
  addColumn: (table: string, field: string, options: Record<string, unknown>) => Promise<unknown>;
  removeColumn: (table: string, field: string) => Promise<unknown>;
};

const SUBSCRIPTIONS = 'agentiz_harness_subscriptions';

/**
 * "Open windows back to back" (см. lib/harnessAlign.ts): when a session window closes, open the
 * next one immediately instead of waiting for work to arrive. Off by default — the flag spends a
 * live request on the account roughly five times a day, including nights nobody works.
 */
export async function up({ context }: { context: QI }) {
  await context.addColumn(SUBSCRIPTIONS, 'keepWindowsOpen', {
    type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false,
  });
}

export async function down({ context }: { context: QI }) {
  await context.removeColumn(SUBSCRIPTIONS, 'keepWindowsOpen');
}
