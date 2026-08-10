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

async function addWaitingInput(context: QI): Promise<void> {
  if (context.sequelize.getDialect() === 'postgres') {
    await context.sequelize.query(`ALTER TYPE "enum_agentiz_tasks_status" ADD VALUE IF NOT EXISTS 'waiting_input'`);
    await context.sequelize.query(`ALTER TYPE "enum_agentiz_runs_status" ADD VALUE IF NOT EXISTS 'waiting_input'`);
    await context.sequelize.query(`ALTER TYPE "enum_agentiz_stage_executions_status" ADD VALUE IF NOT EXISTS 'waiting_input'`);
    return;
  }
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
