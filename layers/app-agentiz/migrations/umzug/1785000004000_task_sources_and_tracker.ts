import { DataTypes } from 'sequelize';

/**
 * Two features land together because they touch the same table:
 *
 * 1. `agentiz_task_sources` — a project can pull tasks from several remote task managers at once,
 *    each row configuring one adapter from the `taskManagers` collection. The origin is recorded
 *    on every mirrored task (`sourceId` / `sourceType` / `sourceName`) so the local task list can
 *    say where each task came from.
 * 2. `agentiz_task_comments` plus `priority`/`assigneeId` on tasks — the built-in tracker, where
 *    people and agents discuss a task in one thread.
 *
 * Existing rows are backfilled from the project's own repoProvider, so tasks synced before this
 * migration still show an origin instead of "unknown".
 */
type QI = {
  sequelize: {
    getDialect: () => string;
    query: (sql: string, options?: Record<string, unknown>) => Promise<unknown>;
  };
  createTable: (name: string, attrs: Record<string, unknown>) => Promise<unknown>;
  addColumn: (table: string, column: string, attr: Record<string, unknown>) => Promise<unknown>;
  removeColumn: (table: string, column: string) => Promise<unknown>;
  addIndex: (table: string, fields: string[], options?: Record<string, unknown>) => Promise<unknown>;
  dropTable: (name: string) => Promise<unknown>;
};

function jsonType(context: QI) {
  return context.sequelize.getDialect() === 'postgres' ? DataTypes.JSONB : DataTypes.JSON;
}

export async function up({ context }: { context: QI }) {
  const json = jsonType(context);

  await context.createTable('agentiz_task_sources', {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    projectId: { type: DataTypes.STRING, allowNull: false },
    name: { type: DataTypes.STRING, allowNull: false },
    type: { type: DataTypes.STRING, allowNull: false },
    config: { type: json, allowNull: true },
    secrets: { type: json, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    lastSyncedAt: { type: DataTypes.DATE, allowNull: true },
    lastError: { type: DataTypes.TEXT, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });

  await context.addIndex('agentiz_task_sources', ['projectId'], {
    name: 'agentiz_task_sources_project_idx',
  });

  await context.createTable('agentiz_task_comments', {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    taskId: { type: DataTypes.STRING, allowNull: false },
    authorKind: { type: DataTypes.STRING, allowNull: false, defaultValue: 'human' },
    authorName: { type: DataTypes.STRING, allowNull: true },
    authorId: { type: DataTypes.INTEGER, allowNull: true },
    runId: { type: DataTypes.STRING, allowNull: true },
    body: { type: DataTypes.TEXT, allowNull: false },
    externalId: { type: DataTypes.STRING, allowNull: true },
    externalUrl: { type: DataTypes.STRING, allowNull: true },
    meta: { type: json, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });

  await context.addIndex('agentiz_task_comments', ['taskId'], {
    name: 'agentiz_task_comments_task_idx',
  });

  await context.addColumn('agentiz_tasks', 'sourceId', { type: DataTypes.STRING, allowNull: true });
  await context.addColumn('agentiz_tasks', 'sourceType', { type: DataTypes.STRING, allowNull: true });
  await context.addColumn('agentiz_tasks', 'sourceName', { type: DataTypes.STRING, allowNull: true });
  await context.addColumn('agentiz_tasks', 'priority', {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'normal',
  });
  await context.addColumn('agentiz_tasks', 'assigneeId', { type: DataTypes.INTEGER, allowNull: true });

  await context.addIndex('agentiz_tasks', ['sourceType'], {
    name: 'agentiz_tasks_source_type_idx',
  });

  // Tasks synced before this migration came from the project's own repository configuration.
  // Namespaced ids (`gl-<projectId>-<iid>`) are the GitLab integration layer's, everything else
  // followed AgentProject.repoProvider.
  await context.sequelize.query(`
    UPDATE agentiz_tasks
    SET "sourceType" = 'gitlab'
    WHERE "sourceType" IS NULL AND "externalId" LIKE 'gl-%'
  `);
  await context.sequelize.query(`
    UPDATE agentiz_tasks
    SET "sourceType" = (
      SELECT p."repoProvider" FROM agentiz_projects p WHERE p.id = agentiz_tasks."projectId"
    )
    WHERE "sourceType" IS NULL
  `);
}

export async function down({ context }: { context: QI }) {
  await context.removeColumn('agentiz_tasks', 'assigneeId');
  await context.removeColumn('agentiz_tasks', 'priority');
  await context.removeColumn('agentiz_tasks', 'sourceName');
  await context.removeColumn('agentiz_tasks', 'sourceType');
  await context.removeColumn('agentiz_tasks', 'sourceId');
  await context.dropTable('agentiz_task_comments');
  await context.dropTable('agentiz_task_sources');
}
