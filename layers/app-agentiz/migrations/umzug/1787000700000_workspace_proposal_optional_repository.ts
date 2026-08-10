import { DataTypes } from 'sequelize';

/**
 * A worker directory stops needing a hosted repository record.
 *
 * The repository was only ever used for one thing in this flow: comparing its `cloneUrl` against
 * what `git remote get-url` says in the directory. For a folder maintained by hand on the worker that
 * check is circular — the remote *is* the source of truth, and the operator already granted push from
 * that path — while the record itself has to exist and stay in sync before anything can be pushed.
 *
 * Pinning a repository stays supported and keeps the cross-check; it is now optional.
 */
type QI = {
  sequelize: { getDialect: () => string };
  describeTable: (table: string) => Promise<Record<string, unknown>>;
  changeColumn: (table: string, column: string, attrs: Record<string, unknown>) => Promise<unknown>;
};

const PROPOSALS = 'agentiz_workspace_proposals';

export async function up({ context }: { context: QI }) {
  const table = await context.describeTable(PROPOSALS);
  if (table.repositoryId) {
    await context.changeColumn(PROPOSALS, 'repositoryId', { type: DataTypes.STRING, allowNull: true });
  }
}

/**
 * Reverting can only restore the constraint if every row still names a repository — rows created
 * without one are exactly what this migration allowed, and there is nothing to fill them with.
 */
export async function down({ context }: { context: QI }) {
  const table = await context.describeTable(PROPOSALS);
  if (table.repositoryId) {
    await context.changeColumn(PROPOSALS, 'repositoryId', { type: DataTypes.STRING, allowNull: false });
  }
}
