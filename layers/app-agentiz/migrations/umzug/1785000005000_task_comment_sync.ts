import { DataTypes } from 'sequelize';

/**
 * Makes the task thread two-way: comments written in the external tracker are pulled into
 * `agentiz_task_comments` alongside the local ones.
 *
 * - `origin` separates "written in Agentiz" from "pulled from the tracker". It is deliberately not
 *   folded into `authorKind`: a person commenting in GitLab is still `human`.
 * - `externalCreatedAt` keeps the upstream timestamp, so a pulled thread reads in the order it was
 *   actually written rather than the order we happened to import it.
 * - The unique index on `(taskId, externalId)` is what makes repeated pulls idempotent, including
 *   for comments Agentiz posted upstream itself and then sees coming back.
 */
type QI = {
  sequelize: { getDialect: () => string };
  addColumn: (table: string, column: string, attr: Record<string, unknown>) => Promise<unknown>;
  removeColumn: (table: string, column: string) => Promise<unknown>;
  addIndex: (table: string, fields: string[], options?: Record<string, unknown>) => Promise<unknown>;
  removeIndex: (table: string, name: string) => Promise<unknown>;
};

export async function up({ context }: { context: QI }) {
  await context.addColumn('agentiz_task_comments', 'origin', {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'local',
  });
  await context.addColumn('agentiz_task_comments', 'externalCreatedAt', {
    type: DataTypes.DATE,
    allowNull: true,
  });

  // Partial indexes are not portable across SQLite and Postgres, and a plain unique index would
  // reject a second comment with externalId NULL on some engines. Both engines we target treat
  // NULLs as distinct in a unique index, so local comments (externalId = NULL) stay unconstrained.
  await context.addIndex('agentiz_task_comments', ['taskId', 'externalId'], {
    name: 'agentiz_task_comments_external_uniq',
    unique: true,
  });

  // Off by default on purpose: pulling a thread costs one API call per task, so turning a 200-task
  // sync into 201 requests has to be a decision someone made, not a surprise.
  await context.addColumn('agentiz_task_sources', 'syncComments', {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  });
}

export async function down({ context }: { context: QI }) {
  await context.removeColumn('agentiz_task_sources', 'syncComments');
  await context.removeIndex('agentiz_task_comments', 'agentiz_task_comments_external_uniq');
  await context.removeColumn('agentiz_task_comments', 'externalCreatedAt');
  await context.removeColumn('agentiz_task_comments', 'origin');
}
