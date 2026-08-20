import { Table, Column, Model, DataType, BelongsTo, ForeignKey, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentTask } from './AgentTask';

/**
 * A file attached to an AgentTask — a screenshot, a spec PDF, an input CSV.
 *
 * The row is metadata only; the bytes live on disk under the attachments root
 * (see lib/taskAttachments.ts), at `storagePath` relative to that root. The path is derived from
 * server-generated ids, never from the uploaded name, so a filename can be anything a person
 * types without becoming a path. `fileName` is what humans (and the agent's file listing) see.
 *
 * Attachments ride into a run through the job snapshot as metadata (`task.attachments`); the
 * worker downloads the bytes through its own leased endpoint and lays them out in a temporary
 * directory next to the working tree — never inside it, or they would show up in the run's diff.
 */
@AdminizerModel({
  model: 'AgentTaskAttachment',
  title: 'Task Attachments',
  icon: 'attach_file',
  navbar: {
    visible: false,
    section: 'Agentiz',
  },
})
@Table({ tableName: 'agentiz_task_attachments', timestamps: true })
export class AgentTaskAttachment extends Model<
  InferAttributes<AgentTaskAttachment>,
  InferCreationAttributes<AgentTaskAttachment>
> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @ForeignKey(() => AgentTask)
  @Column({ type: DataType.STRING, allowNull: false })
  declare taskId: string;

  /** Original name as uploaded, sanitized to a plain basename for display and worker layout. */
  @AdminizerField({ title: 'File name', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare fileName: string;

  @AdminizerField({ title: 'MIME type', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare mimeType: string | null;

  @AdminizerField({ title: 'Size (bytes)', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare sizeBytes: number;

  /** Integrity mark: the worker re-hashes what it downloaded and refuses a mismatch. */
  @Column({ type: DataType.STRING, allowNull: true })
  declare sha256: string | null;

  /** Path relative to the attachments root; built from ids, never from the uploaded name. */
  @Column({ type: DataType.STRING, allowNull: false })
  declare storagePath: string;

  /** UserAP id of whoever uploaded it through the panel; null for machine writes. */
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare uploadedById: number | null;

  @AdminizerField({ title: 'Uploaded by', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare uploadedByName: string | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: Date;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: Date;

  @BelongsTo(() => AgentTask, 'taskId')
  declare task: AgentTask;
}
