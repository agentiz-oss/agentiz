import { DataTypes } from 'sequelize';

type QI = {
  createTable: (table: string, attributes: Record<string, unknown>) => Promise<unknown>;
  dropTable: (table: string) => Promise<unknown>;
  addIndex: (table: string, fields: string[], options?: Record<string, unknown>) => Promise<unknown>;
  removeIndex: (table: string, index: string) => Promise<unknown>;
};

const ATTACHMENTS = 'agentiz_task_attachments';

/**
 * Files attached to tasks (see models/AgentTaskAttachment.ts). Metadata only — the bytes live on
 * disk under the attachments root, so the table stays cheap to list and to snapshot.
 *
 * The index is `(taskId, createdAt)`: every read is "this task's files, in upload order" — the
 * detail pane, the snapshot builder and the worker download all walk the same list.
 */
export async function up({ context }: { context: QI }) {
  await context.createTable(ATTACHMENTS, {
    id: { type: DataTypes.STRING, primaryKey: true },
    taskId: { type: DataTypes.STRING, allowNull: false },
    fileName: { type: DataTypes.STRING, allowNull: false },
    mimeType: { type: DataTypes.STRING, allowNull: true },
    sizeBytes: { type: DataTypes.INTEGER, allowNull: false },
    sha256: { type: DataTypes.STRING, allowNull: true },
    storagePath: { type: DataTypes.STRING, allowNull: false },
    uploadedById: { type: DataTypes.INTEGER, allowNull: true },
    uploadedByName: { type: DataTypes.STRING, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });
  await context.addIndex(ATTACHMENTS, ['taskId', 'createdAt'], {
    name: 'agentiz_task_attachments_task_idx',
  });
}

export async function down({ context }: { context: QI }) {
  await context.removeIndex(ATTACHMENTS, 'agentiz_task_attachments_task_idx');
  await context.dropTable(ATTACHMENTS);
}
