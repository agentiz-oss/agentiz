import { Table, Column, Model, DataType, BelongsTo, ForeignKey, Default, BeforeValidate } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentProject } from './AgentProject';
import type { PipelineSpecDef } from '../types/agentiz';
import { assertValidSpec, coerceSpec, PIPELINE_SPEC_SCHEMA_TOOL } from '../services/PipelineSpecValidation';

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
  /** Reject malformed specs in every write path, including Adminizer's generic CRUD route. */
  @BeforeValidate
  static validateSpec(instance: PipelineSpec): void {
    // Generic clients (the jsoneditor field, the assistant's create_model_record skill) submit JSON
    // columns as strings, so normalise before validating — the column must hold a document.
    instance.spec = coerceSpec(instance.spec) as PipelineSpecDef;
    assertValidSpec(instance.spec);
  }

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
    // Also the description an agent reads through list_data_models, so it states the shape rather
    // than pointing at a file the agent cannot open.
    tooltip: 'JSON object, required keys "stages" and "finalAction". Example:'
      + ' {"stages":[{"order":1,"role":"implement","agentRoleKey":"<AgentRole.key>","runtime":{"mode":"host"}}],"finalAction":{"type":"comment_only"}}.'
      + ' Optional: source, hooks, triggers. To run in a directory on one worker instead of a repository, add'
      + ' "source":{"kind":"worker_workspace","workspace":{"workerId":"<AgentWorker.id>","workspaceKey":"<key>"}}'
      + ' — that requires runtime.mode "host" and finalAction "comment_only" or "none".'
      + ` Call the MCP tool "${PIPELINE_SPEC_SCHEMA_TOOL}" for the full JSON Schema, the cross-field rules and this project's role keys and workspaces.`,
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
