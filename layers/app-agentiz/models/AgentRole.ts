import { Table, Column, Model, DataType, BelongsTo, ForeignKey, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentProject } from './AgentProject';

/**
 * Catalog of reusable agent role definitions, scoped to a project. A PipelineSpec's stages
 * reference roles by `key`; the actual prompt/model/tools live here so they can be edited
 * without touching the pipeline shape.
 */
@AdminizerModel({
  model: 'AgentRole',
  title: 'Agent Roles',
  icon: 'badge',
  userAccessRelation: { field: 'project', via: 'owner' },
  navbar: {
    visible: true,
    section: 'Agentiz',
  },
})
@Table({ tableName: 'agentiz_roles', timestamps: true })
export class AgentRole extends Model<InferAttributes<AgentRole>, InferCreationAttributes<AgentRole>> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @ForeignKey(() => AgentProject)
  @Column({ type: DataType.STRING, allowNull: false })
  declare projectId: string;

  @AdminizerField({ title: 'Key', required: true, tooltip: 'Slug referenced by PipelineSpec.spec.stages[].agentRoleKey', views: { list: true, add: true, edit: true } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare key: string;

  @AdminizerField({ title: 'Title', required: true, views: { list: true, add: true, edit: true } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare title: string;

  @AdminizerField({ title: 'System Prompt', type: 'longtext', views: { list: false, add: true, edit: true } })
  @Column({ type: DataType.TEXT, allowNull: true })
  declare systemPrompt: string | null;

  @AdminizerField({ title: 'Model', tooltip: 'e.g. claude-sonnet-5, claude-opus-4-8', views: { list: true, add: true, edit: true } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare model: string | null;

  @AdminizerField({ title: 'Allowed Tools', type: 'jsoneditor', views: { list: false, add: true, edit: true } })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare allowedTools: string[] | null;

  @AdminizerField({ title: 'Extra Config', type: 'jsoneditor', views: { list: false, add: true, edit: true } })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare config: Record<string, unknown> | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: Date;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: Date;

  @AdminizerField({ title: 'Project', required: true, views: { list: true, add: true, edit: true } })
  @BelongsTo(() => AgentProject, 'projectId')
  declare project: AgentProject;
}
