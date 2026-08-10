import { DataTypes } from 'sequelize';

/**
 * The push grant becomes a property of the machine instead of a per-directory declaration.
 *
 * Before this, pushing from a worker directory required declaring that directory twice — once in the
 * pipeline spec and once again on the worker under a key with `git.pushEnabled` — even though the
 * only thing the second declaration added was the grant itself. `gitPushRoots` states the grant once
 * as path prefixes, so a spec can name any directory below one of them by `path` and commit from it.
 *
 * Existing `workspaces[].git.pushEnabled` declarations keep working untouched: they remain the way to
 * name a remote other than `origin`, and nothing reads this column when they apply.
 */
type QI = {
  sequelize: { getDialect: () => string };
  describeTable: (table: string) => Promise<Record<string, unknown>>;
  addColumn: (table: string, column: string, attr: Record<string, unknown>) => Promise<unknown>;
  removeColumn: (table: string, column: string) => Promise<unknown>;
};

const WORKERS = 'agentiz_workers';

export async function up({ context }: { context: QI }) {
  const json = context.sequelize.getDialect() === 'postgres' ? DataTypes.JSONB : DataTypes.JSON;
  const workers = await context.describeTable(WORKERS);
  if (!workers.gitPushRoots) {
    await context.addColumn(WORKERS, 'gitPushRoots', { type: json, allowNull: true });
  }
}

export async function down({ context }: { context: QI }) {
  const workers = await context.describeTable(WORKERS);
  if (workers.gitPushRoots) await context.removeColumn(WORKERS, 'gitPushRoots');
}
