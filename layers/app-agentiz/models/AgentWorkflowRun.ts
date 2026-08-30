import { Table, Column, Model, DataType, Default, Index } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';

/**
 * One execution of a workflow graph — the engine's `WorkflowRunRecord`, stored.
 *
 * The engine ships an in-memory store and works without this table, but not for the thing that
 * makes a workflow worth having: a node that waits for a pipeline parks the run in
 * `waiting_external` for as long as the pipeline takes, and a deploy in the middle of that would
 * otherwise drop it silently. `externalRef` is indexed because completing such a node is a lookup
 * by that ref (`WorkflowEngine.completeExternal`), which happens on every finished pipeline run.
 *
 * The id comes from the engine (`randomUUID` in `start()`), so there is no default here — a row
 * with a locally generated id would not be findable by the run that owns it.
 */
@Table({ tableName: 'agentiz_workflow_runs', timestamps: false })
export class AgentWorkflowRun extends Model<
  InferAttributes<AgentWorkflowRun>,
  InferCreationAttributes<AgentWorkflowRun>
> {
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: string;

  @Index('agentiz_workflow_runs_spec_idx')
  @Column({ type: DataType.STRING, allowNull: false })
  declare specId: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare providerId: string;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare specVersion: CreationOptional<number | null>;

  /** running | waiting_external | deferred | succeeded | failed | cancelled — the engine's vocabulary. */
  @Column({ type: DataType.STRING, allowNull: false })
  declare status: string;

  /** Node id of the trigger this run started from. */
  @Column({ type: DataType.STRING, allowNull: false })
  declare trigger: string;

  @Column({ type: DataType.JSONB, allowNull: false })
  declare msg: Record<string, unknown>;

  /**
   * Which project and which task this run is about, lifted out of `msg.payload` by the store.
   *
   * The facts were always there, inside a jsonb blob, and that made two ordinary questions
   * un-askable in SQL: "покажи воркфлоу этой задачи" (the card in the task) and "сколько кругов
   * доработки уже было" (the `maxRounds` safeguard of the second trigger input). Both are counted
   * off `taskId` now, which also makes the number visible to a person rather than living in
   * engine state.
   *
   * Nullable because a graph need not be about a task at all — a release flow on a schedule is
   * not.
   */
  @Column({ type: DataType.STRING, allowNull: true })
  declare projectId: CreationOptional<string | null>;

  @Index('agentiz_workflow_runs_task_idx')
  @Column({ type: DataType.STRING, allowNull: true })
  declare taskId: CreationOptional<string | null>;

  @Column({ type: DataType.STRING, allowNull: true })
  declare currentNodeId: CreationOptional<string | null>;

  @Index('agentiz_workflow_runs_external_ref_idx')
  @Column({ type: DataType.STRING, allowNull: true })
  declare externalRef: CreationOptional<string | null>;

  @Column({ type: DataType.DATE, allowNull: true })
  declare waitingUntil: CreationOptional<Date | null>;

  @Column({ type: DataType.STRING, allowNull: true })
  declare waitingReason: CreationOptional<string | null>;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare error: CreationOptional<string | null>;

  @Default(DataType.NOW)
  @Column({ type: DataType.DATE, allowNull: false })
  declare startedAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, allowNull: true })
  declare finishedAt: CreationOptional<Date | null>;

  /** The trace: one entry per node the run walked through, with the msg as it left that node. */
  @Column({ type: DataType.JSONB, allowNull: false })
  declare nodeRuns: Array<Record<string, unknown>>;
}
