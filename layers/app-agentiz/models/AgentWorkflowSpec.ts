import { Table, Column, Model, DataType, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';

/**
 * The graph as the workflow engine reads it — nodes and edges, nothing else. Left untyped beyond
 * the two arrays on purpose: the shape belongs to `@nodeknit/app-workflow`, and the engine
 * validates every graph before it is saved, so mirroring its types here would only produce a
 * second definition to keep in step. `lib/workflow/specProvider.ts` is the one place that names it.
 */
export interface AgentWorkflowGraph {
  nodes: unknown[];
  edges: unknown[];
}

/**
 * One workflow graph, stored for the engine. `@nodeknit/app-workflow` deliberately owns no tables:
 * it reads every spec through a `WorkflowSpecProvider`, and this model is what the Agentiz provider
 * (`lib/workflow/specProvider.ts`) sits on. Without it a flow would live in memory and disappear
 * with the process, which is not a thing anybody can build a flow in.
 *
 * `version` is bumped on every save because a run keeps the version it started with; `active`
 * decides whether the engine arms this flow's triggers at all — an inactive graph is a draft.
 * `projectId` is only a *label*: it makes "the workflows of this project" answerable
 * (`WorkflowSpecRef.entity`) and is not a scope check — the trigger node does its own filtering.
 *
 * No `@AdminizerModel`: the canvas at `/dashboard/workflows` is the editor, and generic CRUD over
 * a raw graph column would offer a second, unvalidated way to write one.
 */
@Table({ tableName: 'agentiz_workflow_specs', timestamps: true })
export class AgentWorkflowSpec extends Model<
  InferAttributes<AgentWorkflowSpec>,
  InferCreationAttributes<AgentWorkflowSpec>
> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @Column({ type: DataType.STRING, allowNull: false })
  declare name: string;

  /** Triggers are armed only for active flows — see WorkflowEngine.rebindTriggers. */
  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare active: CreationOptional<boolean>;

  @Default(1)
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare version: CreationOptional<number>;

  @Column({ type: DataType.JSONB, allowNull: false })
  declare spec: AgentWorkflowGraph;

  /** Owning project, when the flow belongs to one. Descriptive only. */
  @Column({ type: DataType.STRING, allowNull: true })
  declare projectId: CreationOptional<string | null>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: CreationOptional<Date>;
}
