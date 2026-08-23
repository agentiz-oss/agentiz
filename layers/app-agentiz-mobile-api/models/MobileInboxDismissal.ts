import { randomUUID } from 'crypto';
import { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { Column, DataType, Default, Model, Table } from 'sequelize-typescript';

/**
 * One inbox row a person has read and decided to do nothing about.
 *
 * The inbox is computed from live entities on every request, which is what makes an answered
 * question leave the list by itself. Two of its rows have no such entity to be closed by — a run
 * that failed for good and a pull request Agentiz will never hear about again — and those used to
 * stay on the screen until something else pushed them down. That is the state this table records:
 * not "the problem is solved", but "этот человек посмотрел и разбираться не будет".
 *
 * Hence the shape. It is keyed by the **inbox row's id** (`run:<runId>`, `pr:<activityId>`), not by
 * a task or a project: those ids are derived from the entity a row is about, so a task that fails
 * again produces a new run, a new row id and a new row — a dismissal can never hide a future
 * problem. And it is keyed by `userId`, because it is one person's reading decision, not a fact
 * about the run: nothing here is written back to the task, the tracker or the activity feed.
 *
 * It lives in this layer for the same reason `InboxItem` does: the inbox is the mobile API's
 * projection, and `itemId` means nothing outside it.
 */
@AdminizerModel({
  model: 'MobileInboxDismissal',
  title: 'Mobile Inbox Dismissals',
  icon: 'inbox',
  navbar: { visible: false },
})
@Table({ tableName: 'agentiz_mobile_inbox_dismissals', timestamps: true })
export class MobileInboxDismissal extends Model<
  InferAttributes<MobileInboxDismissal>,
  InferCreationAttributes<MobileInboxDismissal>
> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  /** The UserAP id the mobile token carries — the person who dismissed, not the project's owner. */
  @AdminizerField({ title: 'User', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare userId: number;

  /** `InboxItem.id` — the row, not the entity. Unique together with `userId`. */
  @AdminizerField({ title: 'Inbox item', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare itemId: string;

  /**
   * Copied off the row at dismissal time, for reading the table and for pruning — never used to
   * decide whether a row is dismissed. That is `itemId` alone, so the check stays one lookup.
   */
  @AdminizerField({ title: 'Project', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare projectId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare taskId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare runId: string | null;

  /** The catalogue type of the event behind the row — «что именно человек решил не разбирать». */
  @AdminizerField({ title: 'Activity type', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare activityType: string | null;

  @AdminizerField({ title: 'Dismissed at', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
  declare dismissedAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: CreationOptional<Date>;
}
