import { Table, Column, Model, DataType, HasMany, Default, AfterCreate, AfterUpdate } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional, Sequelize, ModelStatic, Model as SequelizeModel, Transaction } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentRole } from './AgentRole';
import { PipelineSpec } from './PipelineSpec';
import { AgentTask } from './AgentTask';
import type { GitProviderType, AgentProjectRepoConfig, AgentProjectTrackerConfig, AgentProjectSecrets } from '../types/agentiz';

@AdminizerModel({
  model: 'AgentProject',
  title: 'Agentiz Projects',
  icon: 'smart_toy',
  navbar: {
    visible: true,
    section: 'Agentiz',
  },
})
@Table({ tableName: 'agentiz_projects', timestamps: true })
export class AgentProject extends Model<InferAttributes<AgentProject>, InferCreationAttributes<AgentProject>> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @AdminizerField({ title: 'Name', required: true, views: { list: true, add: true, edit: true } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare name: string;

  @AdminizerField({ title: 'Slug', required: true, tooltip: 'Used as a stable key for tags/URLs', views: { list: true, add: true, edit: true } })
  @Column({ type: DataType.STRING, allowNull: false, unique: true })
  declare slug: string;

  @AdminizerField({ title: 'Description', type: 'longtext', views: { list: false, add: true, edit: true } })
  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  @AdminizerField({
    title: 'Repo Provider',
    type: 'select',
    isIn: { github: 'GitHub', gitlab: 'GitLab' },
    tooltip: 'Optional: leave empty when every repository comes from an integration',
    views: { list: true, add: true, edit: true },
  })
  @Column({ type: DataType.STRING, allowNull: true })
  declare repoProvider: GitProviderType | null;

  @AdminizerField({
    title: 'Repo Config',
    type: 'jsoneditor',
    tooltip: '{ owner, repo, baseUrl?, defaultBranch? } - passed to the abstract GitProvider. Optional when repositories are attached through integrations.',
    views: { list: false, add: true, edit: true },
  })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare repoConfig: AgentProjectRepoConfig | null;

  @AdminizerField({
    title: 'Tracker Config',
    type: 'jsoneditor',
    tooltip: '{ pollIntervalSec?, query? } - controls GitSyncService polling',
    views: { list: false, add: true, edit: true },
  })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare trackerConfig: AgentProjectTrackerConfig | null;

  @AdminizerField({
    title: 'Secrets',
    type: 'jsoneditor',
    tooltip: '{ token } - masked in UI, see lib/secrets.ts',
    views: { list: false, add: true, edit: true },
    groupsAccessRights: ['admin'],
  })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare secrets: AgentProjectSecrets | null;

  @AdminizerField({ title: 'Active', type: 'boolean', views: { list: true, add: true, edit: true } })
  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare isActive: boolean;

  @AdminizerField({ title: 'Owner', views: { list: false, add: true, edit: true }, groupsAccessRights: ['admin'] })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare ownerId: number | null;
  /** Populated by the UserAP association wired in associate(); UserAP has no exported type. */
  declare owner?: unknown;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastSyncedAt: Date | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: Date;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: Date;

  @HasMany(() => AgentRole, 'projectId')
  declare roles: AgentRole[];

  @HasMany(() => PipelineSpec, 'projectId')
  declare pipelineSpecs: PipelineSpec[];

  @HasMany(() => AgentTask, 'projectId')
  declare tasks: AgentTask[];

  /**
   * The owner's membership row, written in the transaction that set the owner.
   *
   * Not a convenience — a requirement. The access graph resolves project visibility through
   * `AgentProjectMember` rows and never looks at `ownerId`, so a project without one is visible to
   * nobody but an administrator, and that state cannot be fixed from the panel: the members screen
   * itself lives behind `agentiz-project-read`. Sharing the transaction is what keeps the window in
   * which the project exists and nobody can see it from existing at all.
   *
   * There are **two** hooks and both are needed, because in the panel the owner is usually not set
   * at creation: adminizer 5.1.0-build.25 stopped stamping the access column for an administrator,
   * so `/model/AgentProject/add` stores exactly what the form sent — an empty `ownerId` — and the
   * owner is picked afterwards on the edit screen. Reacting only to `create` would therefore cover
   * almost nothing that actually happens. `update` fires whenever `ownerId` changes, which also
   * covers a transfer; the previous owner's row is deliberately left alone, since removing access
   * silently is worse than leaving it to be removed on the members screen.
   *
   * The helper is imported lazily because it reaches AgentProjectMember, which points back here;
   * the cycle is harmless at call time and awkward at module time.
   */
  @AfterCreate
  static async grantOwnerMembership(project: AgentProject, options?: { transaction?: Transaction }) {
    await AgentProject.linkOwner(project, options?.transaction);
  }

  @AfterUpdate
  static async grantOwnerMembershipOnChange(project: AgentProject, options?: { transaction?: Transaction }) {
    // Only when the owner actually moved: a project is updated on every sync, and the membership
    // lookup is a query.
    if (!project.changed || !(project.changed() || []).includes('ownerId')) return;
    await AgentProject.linkOwner(project, options?.transaction);
  }

  private static async linkOwner(project: AgentProject, transaction?: Transaction) {
    if (project.ownerId === null || project.ownerId === undefined) return;
    try {
      const { ensureOwnerMembership } = await import('../lib/access/roleSeed');
      await ensureOwnerMembership({ id: project.id, ownerId: project.ownerId }, transaction);
    } catch (error) {
      // Never fail the write over it: the boot-time backfill covers a project that ends up with
      // no membership row, and a project that cannot be saved at all is the worse outcome.
      console.warn(
        `[app-agentiz] owner membership for project ${project.id} was not created:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  /** Cross-app association, wired in AppAgentiz.mount() after all models are registered. */
  static associate(sequelize: Sequelize) {
    if (!sequelize.isDefined('UserAP')) {
      return;
    }
    const UserAPModel = sequelize.model('UserAP') as ModelStatic<SequelizeModel<{}, {}>>;
    this.belongsTo(UserAPModel, { foreignKey: 'ownerId', as: 'owner' });
  }
}
