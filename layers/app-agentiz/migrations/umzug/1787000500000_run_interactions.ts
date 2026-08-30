import { DataTypes } from 'sequelize';

type QI = {
  sequelize: {
    getDialect: () => string;
    query: (sql: string) => Promise<unknown>;
  };
  createTable: (name: string, attrs: Record<string, unknown>) => Promise<unknown>;
  addIndex: (table: string, fields: string[], options?: Record<string, unknown>) => Promise<unknown>;
  changeColumn: (table: string, field: string, options: Record<string, unknown>) => Promise<unknown>;
  dropTable: (name: string) => Promise<unknown>;
};

const TABLE = 'agentiz_run_interactions';

/**
 * Widen three status ENUMs by one value.
 *
 * **On sqlite this must do nothing at all, and that is not an optimisation.** Sequelize renders an
 * ENUM there as a plain `TEXT` column with no CHECK constraint, so the column already accepts
 * `waiting_input` and there is nothing to widen. What `changeColumn` *would* do is rebuild the
 * whole table — and sequelize's sqlite rebuild reads the old shape through `describeTable`, which
 * copies a **composite** unique index's `unique` flag onto **every** column of it
 * (`lib/dialects/sqlite/query-interface.js`). `agentiz_tasks` has `(projectId, externalId)` unique
 * and `agentiz_stage_executions` has `(runId, stageIndex)`, so the rebuilt tables came out with
 * `projectId`, `externalId`, `runId` and `stageIndex` each marked `UNIQUE` on the column: one task
 * per project, one stage per run, one run per stage row. The symptom is a `UNIQUE constraint
 * failed: agentiz_tasks.projectId` from the seed on a **fresh** database, and it made a sqlite
 * install unusable from the first boot.
 *
 * The same trap is waiting for any future migration: on sqlite, `changeColumn` and `removeColumn`
 * rebuild the table, so on a table carrying a composite unique index they corrupt it. `addColumn`
 * is safe — it is a real `ALTER TABLE ADD COLUMN`. `migrationSchema.test.ts` replays every
 * migration on a fresh sqlite and fails if any column comes out uniquely constrained that should
 * not be.
 *
 * Editing an already-applied migration is safe here precisely because the sqlite branch was a
 * no-op in intent: postgres is untouched, and a sqlite database that already ran it has the broken
 * schema either way — this only stops it happening again. An existing broken sqlite file cannot be
 * repaired through sequelize (its rebuild reads the inline `UNIQUE` back as an index and keeps it)
 * and has to be recreated.
 */
async function addWaitingInput(context: QI): Promise<void> {
  if (context.sequelize.getDialect() === 'postgres') {
    await context.sequelize.query(`ALTER TYPE "enum_agentiz_tasks_status" ADD VALUE IF NOT EXISTS 'waiting_input'`);
    await context.sequelize.query(`ALTER TYPE "enum_agentiz_runs_status" ADD VALUE IF NOT EXISTS 'waiting_input'`);
    await context.sequelize.query(`ALTER TYPE "enum_agentiz_stage_executions_status" ADD VALUE IF NOT EXISTS 'waiting_input'`);
    return;
  }
  if (context.sequelize.getDialect() === 'sqlite') return;
  await context.changeColumn('agentiz_tasks', 'status', {
    type: DataTypes.ENUM('new', 'queued', 'running', 'waiting_input', 'waiting_review', 'done', 'failed', 'cancelled', 'ignored'),
    allowNull: false,
    defaultValue: 'new',
  });
  await context.changeColumn('agentiz_runs', 'status', {
    type: DataTypes.ENUM('pending', 'running', 'waiting_input', 'succeeded', 'failed', 'cancelled'),
    allowNull: false,
    defaultValue: 'pending',
  });
  await context.changeColumn('agentiz_stage_executions', 'status', {
    type: DataTypes.ENUM('pending', 'running', 'waiting_input', 'succeeded', 'failed', 'skipped'),
    allowNull: false,
    defaultValue: 'pending',
  });
}

export async function up({ context }: { context: QI }) {
  await addWaitingInput(context);
  const json = context.sequelize.getDialect() === 'postgres' ? DataTypes.JSONB : DataTypes.JSON;
  await context.createTable(TABLE, {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    projectId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'agentiz_projects', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    runId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'agentiz_runs', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    jobId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'agentiz_run_jobs', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    attempt: { type: DataTypes.INTEGER, allowNull: false },
    stageExecutionId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'agentiz_stage_executions', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    kind: { type: DataTypes.ENUM('elicitation'), allowNull: false, defaultValue: 'elicitation' },
    source: { type: DataTypes.STRING, allowNull: false },
    externalRequestId: { type: DataTypes.STRING, allowNull: false },
    toolCallId: { type: DataTypes.STRING, allowNull: true },
    message: { type: DataTypes.TEXT, allowNull: false },
    requestedSchema: { type: json, allowNull: false },
    status: {
      type: DataTypes.ENUM('pending', 'answered', 'delivered', 'cancelled', 'expired', 'orphaned'),
      allowNull: false,
      defaultValue: 'pending',
    },
    responseAction: { type: DataTypes.ENUM('accept', 'decline', 'cancel'), allowNull: true },
    responseContent: { type: json, allowNull: true },
    answeredById: { type: DataTypes.INTEGER, allowNull: true },
    answeredByName: { type: DataTypes.STRING, allowNull: true },
    answeredAt: { type: DataTypes.DATE, allowNull: true },
    deliveredAt: { type: DataTypes.DATE, allowNull: true },
    expiresAt: { type: DataTypes.DATE, allowNull: true },
    meta: { type: json, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });
  await context.addIndex(TABLE, ['jobId', 'attempt', 'externalRequestId'], {
    unique: true,
    name: 'agentiz_run_interactions_job_attempt_request_unique',
  });
  await context.addIndex(TABLE, ['projectId', 'status'], { name: 'agentiz_run_interactions_project_status' });
  await context.addIndex(TABLE, ['runId', 'createdAt'], { name: 'agentiz_run_interactions_run_created' });
}

export async function down({ context }: { context: QI }) {
  await context.dropTable(TABLE);
  // PostgreSQL enum values cannot be removed safely while keeping the type in use. They are left
  // dormant on down; other dialects can restore the original constraints after remapping rows.
  if (context.sequelize.getDialect() === 'postgres') return;
  await context.sequelize.query(`UPDATE agentiz_tasks SET status = 'running' WHERE status = 'waiting_input'`);
  await context.sequelize.query(`UPDATE agentiz_runs SET status = 'running' WHERE status = 'waiting_input'`);
  await context.sequelize.query(`UPDATE agentiz_stage_executions SET status = 'running' WHERE status = 'waiting_input'`);
  // Same reason as in `addWaitingInput`: on sqlite the rows above are the whole of the rollback,
  // and narrowing the ENUM there would only rebuild three tables and corrupt two of them.
  if (context.sequelize.getDialect() === 'sqlite') return;
  await context.changeColumn('agentiz_tasks', 'status', {
    type: DataTypes.ENUM('new', 'queued', 'running', 'waiting_review', 'done', 'failed', 'cancelled', 'ignored'),
    allowNull: false,
    defaultValue: 'new',
  });
  await context.changeColumn('agentiz_runs', 'status', {
    type: DataTypes.ENUM('pending', 'running', 'succeeded', 'failed', 'cancelled'),
    allowNull: false,
    defaultValue: 'pending',
  });
  await context.changeColumn('agentiz_stage_executions', 'status', {
    type: DataTypes.ENUM('pending', 'running', 'succeeded', 'failed', 'skipped'),
    allowNull: false,
    defaultValue: 'pending',
  });
}
