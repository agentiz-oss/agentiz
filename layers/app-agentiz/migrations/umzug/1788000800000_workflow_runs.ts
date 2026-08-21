import { DataTypes } from 'sequelize';

type QI = {
  createTable: (table: string, attributes: Record<string, unknown>) => Promise<unknown>;
  dropTable: (table: string) => Promise<unknown>;
  addIndex: (table: string, fields: string[], options?: Record<string, unknown>) => Promise<unknown>;
  removeIndex: (table: string, index: string) => Promise<unknown>;
};

const RUNS = 'agentiz_workflow_runs';

/**
 * Durable workflow runs (see models/AgentWorkflowRun.ts). Without this table a flow waiting for a
 * pipeline would be lost on the next deploy, which is exactly the wait that lasts long enough to
 * meet one.
 *
 * Two indexes, both for reads that happen on a schedule rather than on demand: `externalRef` is how
 * a finished pipeline finds the flow waiting for it, `(specId, startedAt)` is the run history the
 * editor and `agentiz.workflowDetails` show.
 */
export async function up({ context }: { context: QI }) {
  await context.createTable(RUNS, {
    id: { type: DataTypes.STRING, primaryKey: true },
    specId: { type: DataTypes.STRING, allowNull: false },
    providerId: { type: DataTypes.STRING, allowNull: false },
    specVersion: { type: DataTypes.INTEGER, allowNull: true },
    status: { type: DataTypes.STRING, allowNull: false },
    trigger: { type: DataTypes.STRING, allowNull: false },
    msg: { type: DataTypes.JSON, allowNull: false },
    currentNodeId: { type: DataTypes.STRING, allowNull: true },
    externalRef: { type: DataTypes.STRING, allowNull: true },
    waitingUntil: { type: DataTypes.DATE, allowNull: true },
    waitingReason: { type: DataTypes.STRING, allowNull: true },
    error: { type: DataTypes.TEXT, allowNull: true },
    startedAt: { type: DataTypes.DATE, allowNull: false },
    finishedAt: { type: DataTypes.DATE, allowNull: true },
    nodeRuns: { type: DataTypes.JSON, allowNull: false },
  });
  await context.addIndex(RUNS, ['externalRef'], { name: 'agentiz_workflow_runs_external_ref_idx' });
  await context.addIndex(RUNS, ['specId', 'startedAt'], { name: 'agentiz_workflow_runs_spec_idx' });
}

export async function down({ context }: { context: QI }) {
  await context.removeIndex(RUNS, 'agentiz_workflow_runs_spec_idx');
  await context.removeIndex(RUNS, 'agentiz_workflow_runs_external_ref_idx');
  await context.dropTable(RUNS);
}
