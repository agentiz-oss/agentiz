import {
  Table, Column, Model, DataType, BelongsTo, ForeignKey, Default,
  AfterCreate, AfterUpdate, AfterDestroy,
} from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentProject } from './AgentProject';
import { AgentGitConnection } from './AgentGitConnection';
import { AgentRepository } from './AgentRepository';
import { scheduleRepositoryWebhookSync } from '../lib/webhooks/repositoryWebhook';
import type { GitProviderType, ProjectRepositoryConfig, ProjectRepositoryRole } from '../types/agentiz';

/**
 * The link this whole model exists for: an Agentiz project <-> one repository.
 *
 * A plain many-to-many row, so a project can carry any number of repositories at once — several
 * from one account, from different accounts, from different instances, and from different platforms
 * side by side.
 *
 * Ids of this table are referenced from `AgentTask.raw.agentizIntegration.integrationId`, which is
 * why the migration that created it copied legacy rows keeping their original primary keys.
 */
@AdminizerModel({
  model: 'AgentProjectRepository',
  title: 'Project Repositories',
  icon: 'hub',
  navbar: {
    visible: true,
    section: 'Agentiz',
  },
})
@Table({ tableName: 'agentiz_project_repositories', timestamps: true })
export class AgentProjectRepository extends Model<
  InferAttributes<AgentProjectRepository>,
  InferCreationAttributes<AgentProjectRepository>
> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @ForeignKey(() => AgentProject)
  @AdminizerField({ title: 'Agentiz project', required: true, views: { list: true, add: true, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare projectId: string;

  @AdminizerField({
    title: 'Provider',
    type: 'select',
    isIn: { github: 'GitHub', gitlab: 'GitLab' },
    views: { list: true, add: false, edit: false },
  })
  @Column({ type: DataType.STRING, allowNull: false })
  declare provider: GitProviderType;

  /** Denormalized like `provider`: the common queries filter links without loading repositories. */
  @ForeignKey(() => AgentGitConnection)
  @AdminizerField({ title: 'Connection', required: true, views: { list: true, add: true, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare connectionId: string;

  @ForeignKey(() => AgentRepository)
  @AdminizerField({ title: 'Repository', required: true, views: { list: true, add: true, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare repositoryId: string;

  @AdminizerField({
    title: 'Role',
    type: 'select',
    isIn: { source: 'Task source', target: 'Commit target', both: 'Source and target' },
    views: { list: true, add: true, edit: true },
  })
  @Default('both')
  @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'both' })
  declare role: CreationOptional<ProjectRepositoryRole>;

  @AdminizerField({
    title: 'Primary',
    type: 'boolean',
    tooltip: 'Repository used when a task carries no repository of its own. At most one per project.',
    views: { list: true, add: true, edit: true },
  })
  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare isPrimary: CreationOptional<boolean>;

  @AdminizerField({ title: 'Sync tasks', type: 'boolean', views: { list: true, add: true, edit: true } })
  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare syncIssues: CreationOptional<boolean>;

  @AdminizerField({ title: 'Active', type: 'boolean', views: { list: true, add: true, edit: true } })
  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare isActive: CreationOptional<boolean>;

  @AdminizerField({
    title: 'Config',
    type: 'jsoneditor',
    tooltip: '{ pollIntervalSec?, query?, defaultBranch? }',
    views: { list: false, add: true, edit: true },
  })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare config: ProjectRepositoryConfig | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastSyncedAt: Date | null;

  @AdminizerField({ title: 'Last error', type: 'longtext', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.TEXT, allowNull: true })
  declare lastError: string | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: CreationOptional<Date>;

  @BelongsTo(() => AgentProject, 'projectId')
  declare project: AgentProject;

  @BelongsTo(() => AgentGitConnection, 'connectionId')
  declare connection: AgentGitConnection;

  @BelongsTo(() => AgentRepository, 'repositoryId')
  declare repository: AgentRepository;

  /**
   * The webhook of the repository follows the links, and follows them from **here**.
   *
   * A link is written by four different callers (the panel, MCP, Adminizer's generic CRUD and a
   * provider layer's own bookkeeping); a model hook is the only place all four pass through, which
   * is the same argument that put the task events on `AgentTask`'s hooks. Fire-and-forget on
   * purpose: this runs inside whatever transaction linked the repository, and a platform being
   * slow or unreachable must not be able to fail that write.
   *
   * `@AfterUpdate` fires for every save, not only for `isActive` — the reconciliation is a cheap
   * "is it linked at all" count, and it is what quietly repairs a repository whose hook fell off.
   *
   * **After the commit, never inside it.** These hooks run within whatever transaction wrote the
   * link, and the work here is a network round trip to a platform plus writes of its own. Started
   * inline it would either hold the transaction open for the length of a GitHub call, or — on
   * sqlite, which serializes one connection — run its queries *beside* the open transaction and
   * break it outright ("cannot commit - no transaction is active"). `afterCommit` is also the only
   * point at which the count this reconciliation is based on is the truth: inside the transaction
   * the row may still be rolled back.
   */
  @AfterCreate
  @AfterUpdate
  @AfterDestroy
  static syncRepositoryWebhook(link: AgentProjectRepository, options?: { transaction?: any }): void {
    const repositoryId = link.repositoryId;
    const transaction = options?.transaction;
    if (transaction && typeof transaction.afterCommit === 'function') {
      transaction.afterCommit(() => scheduleRepositoryWebhookSync(repositoryId));
      return;
    }
    scheduleRepositoryWebhookSync(repositoryId);
  }

  /**
   * Keeps the "one primary per project" invariant. Called after any write that may have set it;
   * doing it here rather than in a route means every caller — panel, layer, future API — gets it.
   */
  static async demoteOtherPrimaries(link: AgentProjectRepository): Promise<void> {
    const siblings = await this.findAll({ where: { projectId: link.projectId, isPrimary: true } });
    for (const sibling of siblings) {
      if (sibling.id !== link.id) await sibling.update({ isPrimary: false });
    }
  }
}
