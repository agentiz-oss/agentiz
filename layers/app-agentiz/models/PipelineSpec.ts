import { Table, Column, Model, DataType, BelongsTo, ForeignKey, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentProject } from './AgentProject';
import type { PipelineSpecDef } from '../types/agentiz';

/**
 * The rule specification the user asked for: "если это не дефолтное для всей системы поведение,
 * то мы идём по спецификации задачи". A project can have several PipelineSpec rows; the one
 * matching the task's tags wins, otherwise the row with isDefault=true for that project is used.
 * Shape of `spec` is documented in ../schemas/pipeline-spec.schema.json and validated by
 * PipelineSpecResolver before a run is created.
 */
@AdminizerModel({
  model: 'PipelineSpec',
  title: 'Pipeline Specs',
  icon: 'schema',
  userAccessRelation: { field: 'project', via: 'owner' },
  navbar: {
    visible: true,
    section: 'Agentiz',
  },
})
@Table({ tableName: 'agentiz_pipeline_specs', timestamps: true })
export class PipelineSpec extends Model<InferAttributes<PipelineSpec>, InferCreationAttributes<PipelineSpec>> {
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
    title: 'Match Tags',
    type: 'jsoneditor',
    tooltip: 'Array of tags this spec applies to. Ignored when Is Default is checked.',
    views: { list: false, add: true, edit: true },
  })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare matchTags: string[] | null;

  @AdminizerField({ title: 'Is Default', type: 'boolean', tooltip: 'Fallback spec for this project when no tag-specific spec matches', views: { list: true, add: true, edit: true } })
  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare isDefault: boolean;

  @AdminizerField({ title: 'Active', type: 'boolean', views: { list: true, add: true, edit: true } })
  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare isActive: boolean;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare version: number;

  @AdminizerField({
    title: 'Spec (JSON)',
    type: 'jsoneditor',
    tooltip: 'See schemas/pipeline-spec.schema.json: { match?, stages: [{order,role,agentRoleKey,onFail}], finalAction }',
    required: true,
    views: { list: false, add: true, edit: true },
  })
  @Column({ type: DataType.JSONB, allowNull: false })
  declare spec: PipelineSpecDef;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: Date;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: Date;

  @AdminizerField({ title: 'Project', required: true, views: { list: true, add: true, edit: true } })
  @BelongsTo(() => AgentProject, 'projectId')
  declare project: AgentProject;
}
