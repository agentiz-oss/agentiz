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

  await context.createTable('agentiz_projects', {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    name: { type: DataTypes.STRING, allowNull: false },
    slug: { type: DataTypes.STRING, allowNull: false, unique: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    repoProvider: { type: DataTypes.STRING, allowNull: false },
    repoConfig: { type: json, allowNull: false },
    trackerConfig: { type: json, allowNull: true },
    secrets: { type: json, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    ownerId: { type: DataTypes.INTEGER, allowNull: true },
    lastSyncedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });

  await context.createTable('agentiz_roles', {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    projectId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'agentiz_projects', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    key: { type: DataTypes.STRING, allowNull: false },
    title: { type: DataTypes.STRING, allowNull: false },
    systemPrompt: { type: DataTypes.TEXT, allowNull: true },
    model: { type: DataTypes.STRING, allowNull: true },
    allowedTools: { type: json, allowNull: true },
    config: { type: json, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });
  await context.addIndex('agentiz_roles', ['projectId', 'key'], {
    unique: true,
    name: 'agentiz_roles_project_key_unique',
  });

  await context.createTable('agentiz_pipeline_specs', {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    projectId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'agentiz_projects', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    name: { type: DataTypes.STRING, allowNull: false },
    matchTags: { type: json, allowNull: true },
    isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    spec: { type: json, allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });
  await context.addIndex('agentiz_pipeline_specs', ['projectId']);

  await context.createTable('agentiz_tasks', {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    projectId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'agentiz_projects', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    externalId: { type: DataTypes.STRING, allowNull: false },
    externalUrl: { type: DataTypes.STRING, allowNull: true },
    title: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    tags: { type: json, allowNull: true },
    externalStatus: { type: DataTypes.STRING, allowNull: true },
    status: {
      type: DataTypes.ENUM('new', 'queued', 'running', 'waiting_review', 'done', 'failed', 'cancelled', 'ignored'),
      allowNull: false,
      defaultValue: 'new',
    },
    pipelineSpecId: {
      type: DataTypes.STRING,
      allowNull: true,
      references: { model: 'agentiz_pipeline_specs', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    },
    raw: { type: json, allowNull: true },
    lastSyncedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });
  await context.addIndex('agentiz_tasks', ['projectId', 'externalId'], {
    unique: true,
    name: 'agentiz_tasks_project_external_id_unique',
  });

  await context.createTable('agentiz_runs', {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    taskId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'agentiz_tasks', key: 'id' },
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
      type: DataTypes.ENUM('pending', 'running', 'succeeded', 'failed', 'cancelled'),
      allowNull: false,
      defaultValue: 'pending',
    },
    trigger: {
      type: DataTypes.ENUM('sync', 'manual', 'webhook', 'schedule'),
      allowNull: false,
      defaultValue: 'manual',
    },
    pipelineSnapshot: { type: json, allowNull: false },
    currentStageIndex: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    startedAt: { type: DataTypes.DATE, allowNull: true },
    finishedAt: { type: DataTypes.DATE, allowNull: true },
    resultSummary: { type: DataTypes.TEXT, allowNull: true },
    commitSha: { type: DataTypes.STRING, allowNull: true },
    commitUrl: { type: DataTypes.STRING, allowNull: true },
    responseUrl: { type: DataTypes.STRING, allowNull: true },
    errorMessage: { type: DataTypes.TEXT, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });
  await context.addIndex('agentiz_runs', ['taskId']);
  await context.addIndex('agentiz_runs', ['projectId']);

  await context.createTable('agentiz_stage_executions', {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    runId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'agentiz_runs', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    stageIndex: { type: DataTypes.INTEGER, allowNull: false },
    role: { type: DataTypes.STRING, allowNull: false },
    agentRoleId: {
      type: DataTypes.STRING,
      allowNull: true,
      references: { model: 'agentiz_roles', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    },
    status: {
      type: DataTypes.ENUM('pending', 'running', 'succeeded', 'failed', 'skipped'),
      allowNull: false,
      defaultValue: 'pending',
    },
    input: { type: json, allowNull: true },
    output: { type: json, allowNull: true },
    startedAt: { type: DataTypes.DATE, allowNull: true },
    finishedAt: { type: DataTypes.DATE, allowNull: true },
    errorMessage: { type: DataTypes.TEXT, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });
  await context.addIndex('agentiz_stage_executions', ['runId', 'stageIndex'], {
    unique: true,
    name: 'agentiz_stage_executions_run_stage_index_unique',
  });

  await context.createTable('agentiz_run_logs', {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    runId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'agentiz_runs', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    stageExecutionId: {
      type: DataTypes.STRING,
      allowNull: true,
      references: { model: 'agentiz_stage_executions', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    },
    level: {
      type: DataTypes.ENUM('debug', 'info', 'warn', 'error'),
      allowNull: false,
      defaultValue: 'info',
    },
    message: { type: DataTypes.TEXT, allowNull: false },
    meta: { type: json, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });
  await context.addIndex('agentiz_run_logs', ['runId']);
}

export async function down({ context }: { context: QI }) {
  await context.dropTable('agentiz_run_logs');
  await context.dropTable('agentiz_stage_executions');
  await context.dropTable('agentiz_runs');
  await context.dropTable('agentiz_tasks');
  await context.dropTable('agentiz_pipeline_specs');
  await context.dropTable('agentiz_roles');
  await context.dropTable('agentiz_projects');
}
