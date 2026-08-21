import { Table, Column, Model, DataType, BelongsTo, HasMany, ForeignKey, Default, AfterCreate, AfterUpdate } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentProject } from './AgentProject';
import { PipelineSpec } from './PipelineSpec';
import { AgentRun } from './AgentRun';
import { AgentTaskComment } from './AgentTaskComment';
import type { AgentTaskPriority, AgentTaskStatus } from '../types/agentiz';
import {
  AGENTIZ_TASK_CREATED,
  AGENTIZ_TASK_UPDATED,
  emitAgentizEvent,
  taskEventPayload,
} from '../lib/workflow/events';

/**
 * Fields whose change is worth waking a workflow for. Status is deliberately absent: a run moves
 * it constantly, so listening to it would make every pipeline start an event, and a flow that
 * starts pipelines would feed itself.
 */
const WORKFLOW_WATCHED_FIELDS = ['title', 'description', 'tags'];

/**
 * A task pulled from the external tracker (GitHub/GitLab issue) and mirrored locally so we can
 * track our own pipeline lifecycle (`status`) separately from the tracker's own state
 * (`externalStatus`). See services/GitSyncService for the upsert logic.
 */
@AdminizerModel({
  model: 'AgentTask',
  title: 'Agentiz Tasks',
  icon: 'task_alt',
  userAccessRelation: { field: 'project', via: 'owner' },
  navbar: {
    visible: true,
    section: 'Agentiz',
  },
})
@Table({ tableName: 'agentiz_tasks', timestamps: true })
export class AgentTask extends Model<InferAttributes<AgentTask>, InferCreationAttributes<AgentTask>> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @ForeignKey(() => AgentProject)
  @Column({ type: DataType.STRING, allowNull: false })
  declare projectId: string;

  @AdminizerField({ title: 'External ID', required: true, views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare externalId: string;

  @AdminizerField({ title: 'External URL', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare externalUrl: string | null;

  @AdminizerField({ title: 'Title', required: true, views: { list: true, add: true, edit: true } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare title: string;

  @AdminizerField({ title: 'Description', type: 'longtext', views: { list: false, add: true, edit: true } })
  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  @AdminizerField({ title: 'Tags', type: 'jsoneditor', tooltip: 'Labels from the tracker, matched against PipelineSpec.matchTags', views: { list: true, add: true, edit: true } })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare tags: string[] | null;

  /**
   * Which branch this task is worked on. A person's decision, not a property of the upstream issue,
   * so no synchroniser ever writes it — see GitSyncService/GitlabIssueSyncService, which list the
   * fields they overwrite explicitly.
   */
  @AdminizerField({
    title: 'Branch',
    tooltip: 'Ветка, с которой работать по этой задаче. Пусто = ветка из пайплайна или default репозитория.',
    views: { list: false, add: true, edit: true },
  })
  @Column({ type: DataType.STRING, allowNull: true })
  declare branchRef: string | null;

  @AdminizerField({ title: 'External Status', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare externalStatus: string | null;

  @AdminizerField({
    title: 'Pipeline Status',
    type: 'select',
    isIn: {
      new: 'New',
      queued: 'Queued',
      running: 'Running',
      waiting_input: 'Waiting input',
      waiting_review: 'Waiting review',
      done: 'Done',
      failed: 'Failed',
      cancelled: 'Cancelled',
      ignored: 'Ignored',
    },
    views: { list: true, add: false, edit: true },
  })
  @Default('new')
  @Column({
    type: DataType.ENUM('new', 'queued', 'running', 'waiting_input', 'waiting_review', 'done', 'failed', 'cancelled', 'ignored'),
    allowNull: false,
    defaultValue: 'new',
  })
  declare status: AgentTaskStatus;

  @AdminizerField({
    title: 'Priority',
    type: 'select',
    isIn: { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' },
    views: { list: true, add: true, edit: true },
  })
  @Default('normal')
  @Column({
    type: DataType.ENUM('low', 'normal', 'high', 'urgent'),
    allowNull: false,
    defaultValue: 'normal',
  })
  declare priority: CreationOptional<AgentTaskPriority>;

  /** UserAP id of whoever owns the task in the built-in tracker. */
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare assigneeId: number | null;

  /**
   * Which task manager this task was mirrored from. `sourceId` points at the AgentTaskSource row
   * when the generic mechanism produced it; `sourceType` is the adapter key (github/gitlab/jira)
   * and survives even when that row is deleted, so the task list can always name its origin.
   * Both are null for a task created by hand in Agentiz.
   */
  @Column({ type: DataType.STRING, allowNull: true })
  declare sourceId: string | null;

  @AdminizerField({ title: 'Source', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare sourceType: string | null;

  /** Human label of the origin ("GitHub Issues · nodeknit/demo-repo"), denormalized for the list. */
  @Column({ type: DataType.STRING, allowNull: true })
  declare sourceName: string | null;

  @ForeignKey(() => PipelineSpec)
  @Column({ type: DataType.STRING, allowNull: true })
  declare pipelineSpecId: string | null;

  @AdminizerField({ title: 'Raw payload', type: 'jsoneditor', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare raw: Record<string, unknown> | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastSyncedAt: Date | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: Date;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: Date;

  @AdminizerField({ title: 'Project', required: true, views: { list: true, add: true, edit: true } })
  @BelongsTo(() => AgentProject, 'projectId')
  declare project: AgentProject;

  @BelongsTo(() => PipelineSpec, 'pipelineSpecId')
  declare pipelineSpec: PipelineSpec | null;

  @HasMany(() => AgentRun, 'taskId')
  declare runs: AgentRun[];

  @HasMany(() => AgentTaskComment, 'taskId')
  declare comments: AgentTaskComment[];

  /**
   * "A task arrived" as an event on the app-manager emitter — the entry point of every workflow
   * that reacts to tasks (see lib/workflow/events.ts).
   *
   * On the model rather than at the call sites because there are four of them (tracker sync,
   * generic task-source sync, the panel/MCP `AgentTaskService.create`, the mobile API) and a fifth
   * would silently not fire. The same caveat as the `run.succeeded` hook applies: a bulk
   * `AgentTask.bulkCreate` / `AgentTask.update({...}, { where })` bypasses instance hooks, so
   * anything writing tasks that way has to emit for itself.
   */
  @AfterCreate
  static emitWorkflowCreated(task: AgentTask): void {
    emitAgentizEvent(AGENTIZ_TASK_CREATED, taskEventPayload(task));
  }

  @AfterUpdate
  static emitWorkflowUpdated(task: AgentTask): void {
    const changed = (task.changed() || []).filter((field) => WORKFLOW_WATCHED_FIELDS.includes(String(field)));
    if (changed.length === 0) return;
    emitAgentizEvent(AGENTIZ_TASK_UPDATED, { ...taskEventPayload(task), changed: changed.map(String) });
  }
}
