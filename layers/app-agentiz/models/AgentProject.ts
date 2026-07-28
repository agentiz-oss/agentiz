import { Table, Column, Model, DataType, HasMany, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional, Sequelize, ModelStatic, Model as SequelizeModel } from 'sequelize';
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
  userAccessRelation: 'owner',
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

  /** Cross-app association, wired in AppAgentiz.mount() after all models are registered. */
  static associate(sequelize: Sequelize) {
    if (!sequelize.isDefined('UserAP')) {
      return;
    }
    const UserAPModel = sequelize.model('UserAP') as ModelStatic<SequelizeModel<{}, {}>>;
    this.belongsTo(UserAPModel, { foreignKey: 'ownerId', as: 'owner' });
  }
}
