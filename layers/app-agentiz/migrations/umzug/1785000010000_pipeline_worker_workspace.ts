import { DataTypes } from 'sequelize';

/**
 * Makes a pipeline able to run in a directory that already exists on one worker instead of in a
 * checkout of a hosted repository.
 *
 * Two columns carry it: the worker declares which directories it offers, and the queued job records
 * that it may only run on that worker. Pinning lives in a column rather than inside `snapshot`
 * because the claim query has to filter on it under `FOR UPDATE SKIP LOCKED`, and JSON filtering is
 * not portable between the postgres and sqlite deployments this project supports.
 */
type QI = {
  describeTable: (table: string) => Promise<Record<string, unknown>>;
  addColumn: (table: string, column: string, attr: Record<string, unknown>) => Promise<unknown>;
  removeColumn: (table: string, column: string) => Promise<unknown>;
  addIndex: (table: string, fields: string[], options?: Record<string, unknown>) => Promise<unknown>;
  removeIndex: (table: string, name: string) => Promise<unknown>;
  sequelize: { getDialect: () => string };
};

const WORKERS = 'agentiz_workers';
const JOBS = 'agentiz_run_jobs';

export async function up({ context }: { context: QI }) {
  const json = context.sequelize.getDialect() === 'postgres' ? DataTypes.JSONB : DataTypes.JSON;

  const workers = await context.describeTable(WORKERS);
  if (!workers.workspaces) {
    await context.addColumn(WORKERS, 'workspaces', { type: json, allowNull: true });
  }

  const jobs = await context.describeTable(JOBS);
  if (!jobs.requiredWorkerId) {
    await context.addColumn(JOBS, 'requiredWorkerId', {
      type: DataTypes.STRING,
      allowNull: true,
      references: { model: WORKERS, key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    // The claim query reads it on every poll of every worker.
    await context.addIndex(JOBS, ['requiredWorkerId'], { name: 'agentiz_run_jobs_required_worker_idx' });
  }
}

export async function down({ context }: { context: QI }) {
  const jobs = await context.describeTable(JOBS);
  if (jobs.requiredWorkerId) {
    await context.removeIndex(JOBS, 'agentiz_run_jobs_required_worker_idx');
    await context.removeColumn(JOBS, 'requiredWorkerId');
  }
  const workers = await context.describeTable(WORKERS);
  if (workers.workspaces) await context.removeColumn(WORKERS, 'workspaces');
}
