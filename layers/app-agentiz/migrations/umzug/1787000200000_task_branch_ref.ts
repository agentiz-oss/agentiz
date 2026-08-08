import { DataTypes } from 'sequelize';

/**
 * Which branch a run works on, and which commit that branch resolved to.
 *
 * `agentiz_tasks.branchRef` is the task's own override; `agentiz_runs.baseRef`/`baseSha` record
 * what the run actually started from. The pair is stored rather than re-derived because a branch
 * moves: between queueing a job and the worker claiming it somebody pushes, and a retry of the same
 * job must still see the same code.
 */
type QI = {
  describeTable: (table: string) => Promise<Record<string, unknown>>;
  addColumn: (table: string, column: string, attr: Record<string, unknown>) => Promise<unknown>;
  removeColumn: (table: string, column: string) => Promise<unknown>;
};

const TASKS = 'agentiz_tasks';
const RUNS = 'agentiz_runs';

export async function up({ context }: { context: QI }) {
  const tasks = await context.describeTable(TASKS);
  if (!tasks.branchRef) {
    await context.addColumn(TASKS, 'branchRef', { type: DataTypes.STRING, allowNull: true });
  }

  const runs = await context.describeTable(RUNS);
  if (!runs.baseRef) {
    await context.addColumn(RUNS, 'baseRef', { type: DataTypes.STRING, allowNull: true });
  }
  if (!runs.baseSha) {
    await context.addColumn(RUNS, 'baseSha', { type: DataTypes.STRING, allowNull: true });
  }
}

export async function down({ context }: { context: QI }) {
  const runs = await context.describeTable(RUNS);
  if (runs.baseSha) await context.removeColumn(RUNS, 'baseSha');
  if (runs.baseRef) await context.removeColumn(RUNS, 'baseRef');
  const tasks = await context.describeTable(TASKS);
  if (tasks.branchRef) await context.removeColumn(TASKS, 'branchRef');
}
