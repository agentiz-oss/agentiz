import { Table, Column, Model, DataType } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes } from 'sequelize';

/**
 * "This user has seen the feed up to this moment" — one row per user, nothing per activity.
 *
 * The unseen badge is `COUNT(activities WHERE createdAt > seenAt)` over the user's projects;
 * activities themselves stay immutable (see AgentActivity). Deliberately not a read-flag table:
 * per-row read state would double every insert and answer a question nobody asked.
 */
@Table({ tableName: 'agentiz_activity_seen', timestamps: false })
export class AgentActivitySeen extends Model<InferAttributes<AgentActivitySeen>, InferCreationAttributes<AgentActivitySeen>> {
  /** Adminizer UserAP id — the same number AgentProject.ownerId holds. */
  @Column({ type: DataType.INTEGER, primaryKey: true })
  declare userId: number;

  @Column({ type: DataType.DATE, allowNull: false })
  declare seenAt: Date;
}
