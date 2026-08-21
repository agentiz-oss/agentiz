import { DataTypes } from 'sequelize';

type QI = {
  createTable: (table: string, attributes: Record<string, unknown>) => Promise<unknown>;
  dropTable: (table: string) => Promise<unknown>;
  addIndex: (table: string, fields: string[], options?: Record<string, unknown>) => Promise<unknown>;
  removeIndex: (table: string, index: string) => Promise<unknown>;
};

const SPECS = 'agentiz_workflow_specs';

/**
 * Storage for workflow graphs (see models/AgentWorkflowSpec.ts). The engine keeps no tables of its
 * own, so without this one every flow would be in-memory and gone on the next deploy.
 *
 * The index is `(active, updatedAt)`: the only hot read is the engine rebinding triggers, which
 * asks for the active flows, and the panel's list, which shows them newest first.
 */
export async function up({ context }: { context: QI }) {
  await context.createTable(SPECS, {
    id: { type: DataTypes.STRING, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    spec: { type: DataTypes.JSON, allowNull: false },
    projectId: { type: DataTypes.STRING, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });
  await context.addIndex(SPECS, ['active', 'updatedAt'], {
    name: 'agentiz_workflow_specs_active_idx',
  });
}

export async function down({ context }: { context: QI }) {
  await context.removeIndex(SPECS, 'agentiz_workflow_specs_active_idx');
  await context.dropTable(SPECS);
}
