import { DataTypes } from 'sequelize';

type QI = {
  addColumn: (table: string, field: string, options: Record<string, unknown>) => Promise<unknown>;
  removeColumn: (table: string, field: string) => Promise<unknown>;
};

const PROPOSALS = 'agentiz_workspace_proposals';

/**
 * Where a rejected proposal's work went.
 *
 * `workspace_reset` stashes the directory instead of discarding it, so a reject is a verdict on the
 * proposal and not on the files. That only helps if the stash can be found afterwards: `stashSha`
 * is the stash commit (stable, unlike `stash@{0}`), `abandonedRef` the ref parking a commit the
 * agent made before the reject. Both null when the directory had nothing to keep.
 */
export async function up({ context }: { context: QI }) {
  await context.addColumn(PROPOSALS, 'stashSha', { type: DataTypes.STRING, allowNull: true });
  await context.addColumn(PROPOSALS, 'abandonedRef', { type: DataTypes.STRING, allowNull: true });
}

export async function down({ context }: { context: QI }) {
  await context.removeColumn(PROPOSALS, 'abandonedRef');
  await context.removeColumn(PROPOSALS, 'stashSha');
}
