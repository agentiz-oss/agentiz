import { DataTypes, QueryTypes } from 'sequelize';

/**
 * `AgentRunLog` becomes visible in the admin dashboard (previously `navbar: { visible: false }`),
 * scoped to a project like every other Agentiz model. That scope needs a direct `project`
 * association, so this adds a denormalized `projectId` (the log only ever points at a run today,
 * one join away from its project) and backfills it from `agentiz_runs.projectId`. It is the edge
 * the `agentiz` access graph now walks — see config/adminizer.ts.
 */
type QI = {
  sequelize: {
    getDialect: () => string;
    query: (sql: string, options: Record<string, unknown>) => Promise<unknown>;
  };
  describeTable: (table: string) => Promise<Record<string, unknown>>;
  addColumn: (table: string, column: string, attr: Record<string, unknown>) => Promise<unknown>;
  removeColumn: (table: string, column: string) => Promise<unknown>;
  addIndex: (table: string, fields: string[], options?: Record<string, unknown>) => Promise<unknown>;
  removeIndex: (table: string, indexName: string) => Promise<unknown>;
};

const TABLE = 'agentiz_run_logs';

export async function up({ context }: { context: QI }) {
  const existing = await context.describeTable(TABLE);

  if (!existing.projectId) {
    await context.addColumn(TABLE, 'projectId', {
      type: DataTypes.STRING,
      allowNull: true,
      references: { model: 'agentiz_projects', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    });
  }

  // Scalar subquery rather than `UPDATE ... FROM`, so this runs unchanged on the SQLite default
  // (see 1785000004000_task_sources_and_tracker.ts for the same portable pattern).
  await context.sequelize.query(
    `UPDATE ${TABLE}
     SET "projectId" = (
       SELECT r."projectId" FROM agentiz_runs r WHERE r.id = ${TABLE}."runId"
     )
     WHERE "projectId" IS NULL`,
    { type: QueryTypes.UPDATE },
  );

  await context.addIndex(TABLE, ['projectId'], { name: 'agentiz_run_logs_project_idx' });
}

export async function down({ context }: { context: QI }) {
  const existing = await context.describeTable(TABLE);
  await context.removeIndex(TABLE, 'agentiz_run_logs_project_idx');
  if (existing.projectId) await context.removeColumn(TABLE, 'projectId');
}
