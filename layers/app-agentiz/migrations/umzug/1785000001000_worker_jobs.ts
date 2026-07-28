import { DataTypes } from 'sequelize';

type QI = {
  sequelize: { getDialect: () => string };
  createTable: (name: string, attrs: Record<string, unknown>) => Promise<unknown>;
  addIndex: (table: string, fields: string[], options?: Record<string, unknown>) => Promise<unknown>;
  dropTable: (name: string) => Promise<unknown>;
};

function jsonType(context: QI) {
  return context.sequelize.getDialect() === 'postgres' ? DataTypes.JSONB : DataTypes.JSON;
}

export async function up({ context }: { context: QI }) {
  const json = jsonType(context);

  await context.createTable('agentiz_run_jobs', {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    runId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'agentiz_runs', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    projectId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'agentiz_projects', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    status: {
      type: DataTypes.ENUM('queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled', 'released', 'dead'),
      allowNull: false,
      defaultValue: 'queued',
    },
    priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100 },
    attempt: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    workerId: { type: DataTypes.STRING, allowNull: true },
    leaseTokenHash: { type: DataTypes.STRING, allowNull: true },
    lockedUntil: { type: DataTypes.DATE, allowNull: true },
    availableAt: { type: DataTypes.DATE, allowNull: false },
    cancelRequestedAt: { type: DataTypes.DATE, allowNull: true },
    cancelReason: { type: DataTypes.TEXT, allowNull: true },
    snapshot: { type: json, allowNull: false },
    result: { type: json, allowNull: true },
    lastError: { type: DataTypes.TEXT, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });
  await context.addIndex('agentiz_run_jobs', ['runId'], {
    unique: true,
    name: 'agentiz_run_jobs_run_unique',
  });
  await context.addIndex('agentiz_run_jobs', ['status', 'availableAt', 'priority'], {
    name: 'agentiz_run_jobs_claim_idx',
  });
  await context.addIndex('agentiz_run_jobs', ['lockedUntil'], {
    name: 'agentiz_run_jobs_locked_until_idx',
  });

  await context.createTable('agentiz_run_event_dedup', {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    jobId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'agentiz_run_jobs', key: 'id' },
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
    attempt: { type: DataTypes.INTEGER, allowNull: false },
    eventId: { type: DataTypes.STRING, allowNull: false },
    sequence: { type: DataTypes.INTEGER, allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });
  await context.addIndex('agentiz_run_event_dedup', ['jobId', 'attempt', 'eventId'], {
    unique: true,
    name: 'agentiz_run_event_dedup_unique',
  });

  await context.createTable('agentiz_run_result_dedup', {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    jobId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'agentiz_run_jobs', key: 'id' },
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
    attempt: { type: DataTypes.INTEGER, allowNull: false },
    resultId: { type: DataTypes.STRING, allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });
  await context.addIndex('agentiz_run_result_dedup', ['jobId', 'attempt', 'resultId'], {
    unique: true,
    name: 'agentiz_run_result_dedup_unique',
  });
}

export async function down({ context }: { context: QI }) {
  await context.dropTable('agentiz_run_result_dedup');
  await context.dropTable('agentiz_run_event_dedup');
  await context.dropTable('agentiz_run_jobs');
}
