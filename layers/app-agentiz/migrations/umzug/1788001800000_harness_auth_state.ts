import type { ModelAttributeColumnOptions, QueryInterface } from 'sequelize';
import { DataTypes } from 'sequelize';

const BINDINGS = 'agentiz_worker_harnesses';

/**
 * "Can this machine log in at all" — the state next to, and deliberately separate from, the
 * subscription's `exhaustedUntil`.
 *
 * A quota belongs to the account; a credential belongs to the machine that stores it, so a worker
 * whose Claude OAuth token has died says nothing about its sibling on the same subscription. All
 * four columns are nullable and nothing backfills them: a binding written before this migration
 * reads as "nobody said", which is exactly how the claim gate behaved before they existed.
 *
 * `addColumn` only — a real `ALTER TABLE ADD COLUMN` on sqlite too. This table carries the
 * composite unique index `(workerId, harnessKey)`, and `removeColumn` would rebuild it with that
 * index spread over both columns (see `migrations/migrationSchema.test.ts`), so the down path
 * drops nothing there.
 */
export const up = async ({ context: queryInterface }: { context: QueryInterface }): Promise<void> => {
  const table = await queryInterface.describeTable(BINDINGS);
  const columns: Array<[string, ModelAttributeColumnOptions]> = [
    ['authState', { type: DataTypes.STRING, allowNull: true }],
    ['authDetail', { type: DataTypes.TEXT, allowNull: true }],
    ['authCheckedAt', { type: DataTypes.DATE, allowNull: true }],
    ['authFailedSince', { type: DataTypes.DATE, allowNull: true }],
  ];
  for (const [name, options] of columns) {
    if (table[name]) continue;
    await queryInterface.addColumn(BINDINGS, name, options);
  }
};

export const down = async ({ context: queryInterface }: { context: QueryInterface }): Promise<void> => {
  if (queryInterface.sequelize.getDialect() === 'sqlite') return;
  await queryInterface.removeColumn(BINDINGS, 'authFailedSince');
  await queryInterface.removeColumn(BINDINGS, 'authCheckedAt');
  await queryInterface.removeColumn(BINDINGS, 'authDetail');
  await queryInterface.removeColumn(BINDINGS, 'authState');
};
