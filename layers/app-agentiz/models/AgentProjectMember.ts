import { Table, Column, Model, DataType, BelongsTo, ForeignKey, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional, Sequelize, ModelStatic, Model as SequelizeModel } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentProject } from './AgentProject';

/**
 * Who takes part in a project, and in which role — the one new table the whole access boundary
 * rests on.
 *
 * It is the `through` model of the `agentiz` access graph (declared in `config/adminizer.ts`):
 * adminizer reads it to answer "which project records may this person see", and
 * `lib/access/projectAccess.ts` reads it to answer "which actions may they take there". Both
 * answers come from the row's `group` — an ordinary `GroupAP` used as a per-project role. Role
 * groups are deliberately **not** in `user.groups`, so they grant nothing globally.
 *
 * Three shapes of the row are load-bearing:
 *
 * - **exactly one relation to `AgentProject`.** `resolveMembership` in adminizer refuses a
 *   membership model that has two, so a second project column here would break every list in
 *   the panel with a graph error rather than a filter.
 * - **`groupId` is NOT NULL.** A membership without a role would grant visibility of everything
 *   in the project and not one project action — "участник, которому ничего нельзя" — and nothing
 *   on the screen would distinguish that from a role handed out wrong. Whoever needs a spectator
 *   gets `Agentiz · Наблюдатели`, which says so.
 * - **the model stays outside the graph** and is closed by the global `agentiz-project-members`
 *   token instead. Inside the graph, a member allowed to read membership rows would read them in
 *   every project they belong to and, worse, the row set is what decides the graph itself.
 *
 * `grantedByUserId` is kept because it is the first question asked when access turns out to be
 * wider than intended, and it is the one thing the row cannot be reconstructed from later.
 */
@AdminizerModel({
  model: 'AgentProjectMember',
  title: 'Project Members',
  icon: 'group',
  navbar: {
    // Membership is edited on the project's own members screen (/dashboard/agentiz-members),
    // which touches nothing but this table. The generic CRUD stays reachable for an administrator.
    visible: false,
    section: 'Agentiz',
  },
})
@Table({
  tableName: 'agentiz_project_members',
  timestamps: true,
  indexes: [
    { name: 'agentiz_project_members_unique_idx', unique: true, fields: ['projectId', 'userId', 'groupId'] },
    { name: 'agentiz_project_members_project_idx', fields: ['projectId', 'userId'] },
    { name: 'agentiz_project_members_user_idx', fields: ['userId'] },
  ],
})
export class AgentProjectMember extends Model<
  InferAttributes<AgentProjectMember>,
  InferCreationAttributes<AgentProjectMember>
> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @ForeignKey(() => AgentProject)
  @AdminizerField({ title: 'Project', required: true, views: { list: true, add: true, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare projectId: string;

  @AdminizerField({ title: 'User', required: true, views: { list: true, add: true, edit: false } })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare userId: number;

  @AdminizerField({ title: 'Role group', required: true, views: { list: true, add: true, edit: true } })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare groupId: number;

  @AdminizerField({ title: 'Granted by', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare grantedByUserId: CreationOptional<number | null>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: CreationOptional<Date>;

  @BelongsTo(() => AgentProject, 'projectId')
  declare project: AgentProject;

  /** Populated by the associations wired in `associate()`; UserAP/GroupAP export no types. */
  declare user?: unknown;
  declare group?: unknown;

  /**
   * Cross-app associations, wired from `AppAgentiz.mount()` after every model is registered —
   * the same shape `AgentProject.associate()` uses for its owner.
   *
   * These two aliases are not cosmetic: the graph's `membership: { via: 'user', group: 'group' }`
   * names them, and `resolveMembership` insists that `via` resolve to `User` and `group` to
   * `Group`. Without this call the graph refuses to compile and every covered list answers 500.
   */
  static associate(sequelize: Sequelize) {
    if (sequelize.isDefined('UserAP')) {
      const UserAPModel = sequelize.model('UserAP') as ModelStatic<SequelizeModel<{}, {}>>;
      this.belongsTo(UserAPModel, { foreignKey: 'userId', as: 'user' });
    }
    if (sequelize.isDefined('GroupAP')) {
      const GroupAPModel = sequelize.model('GroupAP') as ModelStatic<SequelizeModel<{}, {}>>;
      this.belongsTo(GroupAPModel, { foreignKey: 'groupId', as: 'group' });
    }
  }
}
