import { DataTypes } from 'sequelize';

type QI = {
  createTable: (table: string, attributes: Record<string, unknown>) => Promise<unknown>;
  dropTable: (table: string) => Promise<unknown>;
  addColumn: (table: string, field: string, options: Record<string, unknown>) => Promise<unknown>;
  removeColumn: (table: string, field: string) => Promise<unknown>;
  addIndex: (table: string, fields: string[], options?: Record<string, unknown>) => Promise<unknown>;
  removeIndex: (table: string, index: string) => Promise<unknown>;
};

const ACTIVITIES = 'agentiz_activities';
const SEEN = 'agentiz_activity_seen';
const RUNS = 'agentiz_runs';

/**
 * The activity feed (see models/AgentActivity.ts): an immutable journal written on every event,
 * with the per-user "seen up to" mark beside it. The third change rides along because the policy
 * resolver needs it: `agentiz_runs.pipelineSpecId` records which spec a run was created from —
 * `task.pipelineSpecId` cannot stand in, it holds the spec of the task's *latest* run, and an
 * older run may have been created from another one.
 */
export async function up({ context }: { context: QI }) {
  await context.createTable(ACTIVITIES, {
    id: { type: DataTypes.STRING, primaryKey: true },
    type: { type: DataTypes.STRING, allowNull: false },
    kind: { type: DataTypes.STRING, allowNull: false },
    projectId: { type: DataTypes.STRING, allowNull: false },
    runId: { type: DataTypes.STRING, allowNull: true },
    taskId: { type: DataTypes.STRING, allowNull: true },
    proposalId: { type: DataTypes.STRING, allowNull: true },
    interactionId: { type: DataTypes.STRING, allowNull: true },
    title: { type: DataTypes.STRING, allowNull: false },
    body: { type: DataTypes.TEXT, allowNull: false },
    data: { type: DataTypes.JSON, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });
  await context.addIndex(ACTIVITIES, ['projectId', 'createdAt'], { name: 'agentiz_activities_project_created_idx' });
  await context.addIndex(ACTIVITIES, ['createdAt'], { name: 'agentiz_activities_created_idx' });
  await context.createTable(SEEN, {
    userId: { type: DataTypes.INTEGER, primaryKey: true },
    seenAt: { type: DataTypes.DATE, allowNull: false },
  });
  await context.addColumn(RUNS, 'pipelineSpecId', { type: DataTypes.STRING, allowNull: true });
}

export async function down({ context }: { context: QI }) {
  await context.removeColumn(RUNS, 'pipelineSpecId');
  await context.dropTable(SEEN);
  await context.removeIndex(ACTIVITIES, 'agentiz_activities_created_idx');
  await context.removeIndex(ACTIVITIES, 'agentiz_activities_project_created_idx');
  await context.dropTable(ACTIVITIES);
}
