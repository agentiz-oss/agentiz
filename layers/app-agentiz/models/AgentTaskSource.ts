import { Table, Column, Model, DataType, BelongsTo, ForeignKey, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentProject } from './AgentProject';

/**
 * One remote task manager feeding one project.
 *
 * A project is not tied to a single tracker: it can pull from GitHub Issues and Jira and a
 * self-hosted Redmine at the same time, and every mirrored AgentTask records which source it came
 * from (`AgentTask.sourceId` / `sourceType`). `type` refers to an adapter registered in the
 * `taskManagers` collection — a source whose layer is not mounted stays in the list but reports
 * the missing adapter instead of syncing silently.
 */
@AdminizerModel({
  model: 'AgentTaskSource',
  title: 'Task Sources',
  icon: 'inbox',
  userAccessRelation: { field: 'project', via: 'owner' },
  navbar: {
    visible: true,
    section: 'Agentiz',
  },
})
@Table({ tableName: 'agentiz_task_sources', timestamps: true })
export class AgentTaskSource extends Model<InferAttributes<AgentTaskSource>, InferCreationAttributes<AgentTaskSource>> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @ForeignKey(() => AgentProject)
  @Column({ type: DataType.STRING, allowNull: false })
  declare projectId: string;

  @AdminizerField({ title: 'Name', required: true, views: { list: true, add: true, edit: true } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare name: string;

  @AdminizerField({
    title: 'Task manager type',
    required: true,
    tooltip: 'Adapter key from the taskManagers collection, e.g. github / gitlab / jira',
    views: { list: true, add: true, edit: true },
  })
  @Column({ type: DataType.STRING, allowNull: false })
  declare type: string;

  @AdminizerField({ title: 'Config', type: 'jsoneditor', views: { list: false, add: true, edit: true } })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare config: Record<string, unknown> | null;

  /** Never returned to the UI unmasked — see lib/secrets.ts. */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare secrets: Record<string, unknown> | null;

  @AdminizerField({ title: 'Active', type: 'boolean', views: { list: true, add: true, edit: true } })
  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare isActive: CreationOptional<boolean>;

  /**
   * Pull each task's discussion during sync. Off by default: it costs one extra API call per task
   * the sync touched, which on a first full sync is one per task in the tracker.
   */
  @AdminizerField({
    title: 'Sync comments',
    type: 'boolean',
    tooltip: 'Тянуть обсуждение задач при синхронизации (по запросу доступно всегда)',
    views: { list: true, add: true, edit: true },
  })
  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare syncComments: CreationOptional<boolean>;

  @AdminizerField({ title: 'Last synced', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.DATE, allowNull: true })
  declare lastSyncedAt: Date | null;

  @AdminizerField({ title: 'Last error', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.TEXT, allowNull: true })
  declare lastError: string | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: Date;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: Date;

  @AdminizerField({ title: 'Project', required: true, views: { list: true, add: true, edit: true } })
  @BelongsTo(() => AgentProject, 'projectId')
  declare project: AgentProject;
}
