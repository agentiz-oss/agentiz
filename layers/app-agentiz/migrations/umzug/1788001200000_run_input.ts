import type { QueryInterface } from 'sequelize';
import { DataTypes } from 'sequelize';

/**
 * `agentiz_runs.input` — what a workflow handed the run that the task cannot say.
 *
 * `addColumn` only: it is a real `ALTER TABLE ADD COLUMN` on every dialect. `changeColumn` and
 * `removeColumn` corrupt a sqlite table that carries a composite unique index (see
 * `migrations/migrationSchema.test.ts`), so the down path drops nothing on sqlite — a nullable
 * column nobody reads costs less than a rebuilt table with invented unique constraints.
 */
export const up = async ({ context: queryInterface }: { context: QueryInterface }): Promise<void> => {
  const table = await queryInterface.describeTable('agentiz_runs');
  if (table.input) return;
  await queryInterface.addColumn('agentiz_runs', 'input', {
    type: DataTypes.JSONB,
    allowNull: true,
  });
};

export const down = async ({ context: queryInterface }: { context: QueryInterface }): Promise<void> => {
  if (queryInterface.sequelize.getDialect() === 'sqlite') return;
  await queryInterface.removeColumn('agentiz_runs', 'input');
};
