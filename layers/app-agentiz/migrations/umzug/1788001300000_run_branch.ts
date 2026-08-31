import type { QueryInterface } from 'sequelize';
import { DataTypes } from 'sequelize';

/**
 * `agentiz_runs.branch` — the branch this run's work ended up on.
 *
 * It existed nowhere before: a `worker_workspace` run keeps it on its proposal
 * (`agentiz_workspace_proposals.targetBranch`), while a `repository` run computed it inside
 * `applyRepositoryFinalAction` and let it fall out of scope — the name survived only inside a log
 * line. Three consumers ask for it now (the approval a person decides on, the result card, the
 * release query), and deriving it three times from the pipeline snapshot is how the three answers
 * eventually disagree.
 *
 * `addColumn` only, for the reason spelled out in `1788001200000_run_input`: it is a real
 * `ALTER TABLE ADD COLUMN` everywhere, while `removeColumn` corrupts a sqlite table carrying a
 * composite unique index.
 */
export const up = async ({ context: queryInterface }: { context: QueryInterface }): Promise<void> => {
  const table = await queryInterface.describeTable('agentiz_runs');
  if (table.branch) return;
  await queryInterface.addColumn('agentiz_runs', 'branch', {
    type: DataTypes.STRING,
    allowNull: true,
  });
};

export const down = async ({ context: queryInterface }: { context: QueryInterface }): Promise<void> => {
  if (queryInterface.sequelize.getDialect() === 'sqlite') return;
  await queryInterface.removeColumn('agentiz_runs', 'branch');
};
