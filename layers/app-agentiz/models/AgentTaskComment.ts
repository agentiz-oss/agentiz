import { Table, Column, Model, DataType, BelongsTo, ForeignKey, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentTask } from './AgentTask';
import type { AgentTaskCommentAuthorKind, AgentTaskCommentOrigin } from '../types/agentiz';

/**
 * A comment on an AgentTask — the discussion thread of the built-in tracker.
 *
 * Comments come from three sources and the UI must be able to tell them apart at a glance:
 * `human` (a signed-in operator), `agent` (a pipeline run reporting what it did) and `system`
 * (status transitions, sync notes). `runId` links an agent comment back to the run that produced
 * it, so a reader can jump from the thread to the logs.
 *
 * `externalId`/`externalUrl` are set when a comment has been mirrored to the upstream tracker, so
 * pushing the same comment twice is detectable.
 */
@AdminizerModel({
  model: 'AgentTaskComment',
  title: 'Task Comments',
  icon: 'forum',
  remove: false,
  navbar: {
    visible: false,
    section: 'Agentiz',
  },
})
@Table({ tableName: 'agentiz_task_comments', timestamps: true })
export class AgentTaskComment extends Model<
  InferAttributes<AgentTaskComment>,
  InferCreationAttributes<AgentTaskComment>
> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @ForeignKey(() => AgentTask)
  @Column({ type: DataType.STRING, allowNull: false })
  declare taskId: string;

  @AdminizerField({
    title: 'Author kind',
    type: 'select',
    isIn: { human: 'Human', agent: 'Agent', system: 'System' },
    views: { list: true, add: true, edit: false },
  })
  @Default('human')
  @Column({
    type: DataType.ENUM('human', 'agent', 'system'),
    allowNull: false,
    defaultValue: 'human',
  })
  declare authorKind: AgentTaskCommentAuthorKind;

  /** Display name: a user login, an agent role key, or "system". */
  @AdminizerField({ title: 'Author', views: { list: true, add: true, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare authorName: string | null;

  /** UserAP id when authorKind is `human`. */
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare authorId: number | null;

  /** The run that produced an `agent` comment, if any. */
  @Column({ type: DataType.STRING, allowNull: true })
  declare runId: string | null;

  @AdminizerField({ title: 'Body', type: 'longtext', required: true, views: { list: true, add: true, edit: true } })
  @Column({ type: DataType.TEXT, allowNull: false })
  declare body: string;

  /**
   * Where the comment was written. `local` means someone (or some run) wrote it in Agentiz;
   * `remote` means it was pulled from the task's own tracker.
   *
   * Kept separate from `authorKind` because the two are orthogonal: a person commenting in GitLab
   * is still `human`, and conflating "who wrote it" with "where it came from" would make it
   * impossible to show either honestly.
   */
  @AdminizerField({
    title: 'Origin',
    type: 'select',
    isIn: { local: 'Local', remote: 'From tracker' },
    views: { list: true, add: false, edit: false },
  })
  @Default('local')
  @Column({
    type: DataType.ENUM('local', 'remote'),
    allowNull: false,
    defaultValue: 'local',
  })
  declare origin: CreationOptional<AgentTaskCommentOrigin>;

  /**
   * The platform's own comment id. Set on a pulled comment, and also on a local one once it has
   * been pushed upstream — that is what stops the next pull from importing our own comment back
   * as a duplicate. Unique per task.
   */
  @Column({ type: DataType.STRING, allowNull: true })
  declare externalId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare externalUrl: string | null;

  /** When the comment was written upstream; the thread is ordered by this when present. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare externalCreatedAt: Date | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare meta: Record<string, unknown> | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: Date;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: Date;

  @BelongsTo(() => AgentTask, 'taskId')
  declare task: AgentTask;
}
