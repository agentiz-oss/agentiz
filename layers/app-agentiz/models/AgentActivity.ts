import { Table, Column, Model, DataType, BelongsTo, ForeignKey, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentProject } from './AgentProject';
import type { ActivityKind } from '../lib/notifications/activityTypes';

/**
 * One row per "something happened that a person may care about" — the activity feed.
 *
 * The feed is written **always**, whatever the notification policy says: switching a push off must
 * not erase the event from history, or "почему не пришло" becomes undebuggable. Rows are immutable
 * and carry no read/resolved flags — "requires action right now" is computed from the live entities
 * (pending interactions, proposals, held diffs), never duplicated here.
 *
 * `title`/`body` are already human-readable: they are built once by the emitter/dispatcher, and
 * every channel (feed, bell, push) shows them rather than re-deriving its own wording. `data` keeps
 * the machine part — urls, shas, ids a client can deep-link on.
 */
@AdminizerModel({
  model: 'AgentActivity',
  title: 'Activities',
  icon: 'notifications',
  navbar: { visible: false, section: 'Agentiz' },
})
@Table({ tableName: 'agentiz_activities', timestamps: true })
export class AgentActivity extends Model<InferAttributes<AgentActivity>, InferCreationAttributes<AgentActivity>> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  /** From the catalogue in lib/notifications/activityTypes.ts — the dispatcher refuses others. */
  @AdminizerField({ title: 'Type', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare type: string;

  /** Denormalized from the catalogue so "actionable only" is a WHERE, not a JSON walk. */
  @Column({ type: DataType.STRING, allowNull: false })
  declare kind: ActivityKind;

  @ForeignKey(() => AgentProject)
  @Column({ type: DataType.STRING, allowNull: false })
  declare projectId: string;

  @Column({ type: DataType.STRING, allowNull: true }) declare runId: string | null;
  @Column({ type: DataType.STRING, allowNull: true }) declare taskId: string | null;
  @Column({ type: DataType.STRING, allowNull: true }) declare proposalId: string | null;
  @Column({ type: DataType.STRING, allowNull: true }) declare interactionId: string | null;

  @AdminizerField({ title: 'Title', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare title: string;

  @AdminizerField({ title: 'Body', type: 'longtext', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.TEXT, allowNull: false })
  declare body: string;

  /** prUrl, commitSha, revision, truncated errorMessage, deep-link — never prose a person reads. */
  @AdminizerField({ title: 'Data', type: 'jsoneditor', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare data: Record<string, unknown> | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: CreationOptional<Date>;

  @BelongsTo(() => AgentProject, 'projectId')
  declare project: AgentProject;
}
