import { DataTypes } from 'sequelize';

/**
 * Second axis of what a worker may take: not only which projects, but which repositories.
 *
 * `agentiz_run_jobs.repositoryId` is a real column rather than a field inside the `snapshot`
 * JSON because the claim query filters on it in SQL under `FOR UPDATE SKIP LOCKED`, and JSON
 * filtering differs between the postgres and sqlite deployments this project supports.
 *
 * Jobs queued before this migration keep `repositoryId = null` and stay claimable by everyone.
 * That is deliberate: they are already in the queue, and there is nothing to restrict them by
 * retroactively.
 */
type QI = {
  sequelize: { getDialect: () => string };
  describeTable: (table: string) => Promise<Record<string, unknown>>;
  addColumn: (table: string, column: string, attr: Record<string, unknown>) => Promise<unknown>;
  removeColumn: (table: string, column: string) => Promise<unknown>;
  addIndex: (table: string, fields: string[], options?: Record<string, unknown>) => Promise<unknown>;
  removeIndex: (table: string, name: string) => Promise<unknown>;
};

const WORKERS = 'agentiz_workers';
const JOBS = 'agentiz_run_jobs';
const CLAIM_INDEX = 'agentiz_run_jobs_claim_scope_idx';

export async function up({ context }: { context: QI }) {
  const json = context.sequelize.getDialect() === 'postgres' ? DataTypes.JSONB : DataTypes.JSON;

  const workers = await context.describeTable(WORKERS);
  if (!workers.allowedRepositoryIds) {
    await context.addColumn(WORKERS, 'allowedRepositoryIds', { type: json, allowNull: true });
  }

  const jobs = await context.describeTable(JOBS);
  if (!jobs.repositoryId) {
    await context.addColumn(JOBS, 'repositoryId', {
      type: DataTypes.STRING,
      allowNull: true,
      references: { model: 'agentiz_repositories', key: 'id' },
      onUpdate: 'CASCADE',
      // SET NULL, not CASCADE: deleting a repository must not erase the history of what ran.
      onDelete: 'SET NULL',
    });
    await context.addIndex(JOBS, ['status', 'availableAt', 'projectId', 'repositoryId'], { name: CLAIM_INDEX });
  }
}

export async function down({ context }: { context: QI }) {
  const jobs = await context.describeTable(JOBS);
  if (jobs.repositoryId) {
    await context.removeIndex(JOBS, CLAIM_INDEX);
    await context.removeColumn(JOBS, 'repositoryId');
  }
  const workers = await context.describeTable(WORKERS);
  if (workers.allowedRepositoryIds) await context.removeColumn(WORKERS, 'allowedRepositoryIds');
}
