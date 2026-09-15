import { DataTypes } from 'sequelize';

type QI = {
  addColumn: (table: string, field: string, options: Record<string, unknown>) => Promise<unknown>;
  removeColumn: (table: string, field: string) => Promise<unknown>;
};

const REPOSITORIES = 'agentiz_repositories';

/**
 * The two columns a watched repository needs (`.ai-notes/repository-events-workflow-plan.md` §3):
 * where the watcher left off, and the webhook it is watched through.
 *
 * `addColumn` only — the one interface call that is a real `ALTER TABLE ADD COLUMN` on sqlite and
 * therefore does not rebuild the table and copy a composite index's unique flag onto every one of
 * its columns (see AGENTS.md). Both are nullable with no default, so an existing row means
 * "never looked at, no hook" — which is exactly the first-pass state the poller expects.
 */
export async function up({ context }: { context: QI }) {
  await context.addColumn(REPOSITORIES, 'watchCursor', { type: DataTypes.JSONB, allowNull: true });
  await context.addColumn(REPOSITORIES, 'webhook', { type: DataTypes.JSONB, allowNull: true });
}

export async function down({ context }: { context: QI }) {
  await context.removeColumn(REPOSITORIES, 'webhook');
  await context.removeColumn(REPOSITORIES, 'watchCursor');
}
