import { AgentTask } from '../../app-agentiz/models/AgentTask';
import type { AgentProject } from '../../app-agentiz/models/AgentProject';
import { AgentGitConnection } from '../../app-agentiz/models/AgentGitConnection';
import { AgentProjectRepository } from '../../app-agentiz/models/AgentProjectRepository';
import { AgentRepository } from '../../app-agentiz/models/AgentRepository';
import { TASK_REPOSITORY_RAW_KEY } from '../../app-agentiz/services/RepositoryResolverService';
import { GitlabOAuthService } from './GitlabOAuthService';
import type { GitlabIssue } from '../lib/GitlabApiClient';
import { buildTaskExternalId, type TaskIntegrationRef } from '../types/gitlab';

export interface IssueSyncResult {
  fetched: number;
  created: number;
  updated: number;
  errors: string[];
}

/** Same rule as app-agentiz GitSyncService: a task owned by a run is not overwritten upstream. */
const LOCALLY_OWNED_STATUSES = new Set(['queued', 'running', 'waiting_review']);

function emptyResult(): IssueSyncResult {
  return { fetched: 0, created: 0, updated: 0, errors: [] };
}

function mergeInto(target: IssueSyncResult, source: IssueSyncResult): IssueSyncResult {
  target.fetched += source.fetched;
  target.created += source.created;
  target.updated += source.updated;
  target.errors.push(...source.errors);
  return target;
}

/**
 * Mirrors issues of every GitLab repository linked to a project into AgentTask.
 *
 * Because one Agentiz project can aggregate many repositories, task external ids are namespaced
 * (`gl-<gitlabProjectId>-<iid>`) and every task keeps a back-reference to its link in `raw`, which
 * is what lets the pipeline later comment/commit into the right repository.
 */
export class GitlabIssueSyncService {
  static async syncIntegration(linkId: string, options: { force?: boolean } = {}): Promise<IssueSyncResult> {
    const link = await AgentProjectRepository.findByPk(linkId);
    if (!link) throw new Error(`Project repository link ${linkId} not found`);
    return this.syncOne(link, options);
  }

  /** Every active issue-source link of a project. Registered as an app-agentiz sync contributor. */
  static async syncProject(project: AgentProject, options: { force?: boolean } = {}): Promise<IssueSyncResult> {
    return this.syncMany(
      await AgentProjectRepository.findAll({ where: { projectId: project.id, provider: 'gitlab', isActive: true } }),
      options,
    );
  }

  static async syncAll(options: { force?: boolean } = {}): Promise<IssueSyncResult> {
    return this.syncMany(
      await AgentProjectRepository.findAll({ where: { provider: 'gitlab', isActive: true } }),
      options,
    );
  }

  private static async syncMany(
    links: AgentProjectRepository[],
    options: { force?: boolean },
  ): Promise<IssueSyncResult> {
    const result = emptyResult();
    for (const link of links) {
      try {
        mergeInto(result, await this.syncOne(link, options));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`link ${link.id}: ${message}`);
      }
    }
    return result;
  }

  private static isDue(link: AgentProjectRepository, force: boolean): boolean {
    if (force) return true;
    const interval = link.config?.pollIntervalSec ?? 0;
    if (!interval || !link.lastSyncedAt) return true;
    return link.lastSyncedAt.getTime() + interval * 1000 <= Date.now();
  }

  private static async syncOne(
    link: AgentProjectRepository,
    options: { force?: boolean },
  ): Promise<IssueSyncResult> {
    const result = emptyResult();

    if (!link.isActive || !link.syncIssues) return result;
    if (link.role === 'target') return result;
    if (!this.isDue(link, options.force ?? false)) return result;

    const [repository, connection] = await Promise.all([
      AgentRepository.findByPk(link.repositoryId),
      AgentGitConnection.findByPk(link.connectionId),
    ]);
    if (!repository || !connection) {
      const message = 'linked repository or connection is missing';
      await link.update({ lastError: message });
      result.errors.push(message);
      return result;
    }

    let issues: GitlabIssue[];
    try {
      const client = await GitlabOAuthService.apiClientFor(connection);
      issues = await client.listIssues(repository.externalRepoId, {
        updatedAfter: link.lastSyncedAt ?? undefined,
        query: link.config?.query,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await link.update({ lastError: message });
      result.errors.push(`${repository.pathWithNamespace}: ${message}`);
      return result;
    }

    result.fetched = issues.length;

    for (const issue of issues) {
      try {
        const ref: TaskIntegrationRef = {
          provider: 'gitlab',
          integrationId: link.id,
          connectionId: connection.id,
          repositoryId: repository.id,
          gitlabProjectId: Number(repository.externalRepoId),
          issueIid: issue.iid,
        };
        const externalId = buildTaskExternalId(repository.externalRepoId, issue.iid);
        const attributes = {
          externalUrl: issue.web_url,
          title: issue.title,
          description: issue.description ?? '',
          tags: issue.labels ?? [],
          externalStatus: issue.state,
          // Origin of the task, so the Agentiz tracker can name the system it came from. There is
          // no AgentTaskSource row behind an OAuth connection, hence sourceId stays null.
          sourceId: null as string | null,
          sourceType: 'gitlab',
          sourceName: `GitLab Issues · ${repository.pathWithNamespace}`,
          raw: { ...(issue as unknown as Record<string, unknown>), [TASK_REPOSITORY_RAW_KEY]: ref },
          lastSyncedAt: new Date(),
        };

        const existing = await AgentTask.findOne({ where: { projectId: link.projectId, externalId } });

        if (!existing) {
          await AgentTask.create({ projectId: link.projectId, externalId, status: 'new', ...attributes });
          result.created += 1;
          continue;
        }

        const isClosedUpstream = ['closed', 'merged'].includes(issue.state.toLowerCase());
        const keepLocalStatus = LOCALLY_OWNED_STATUSES.has(existing.status);
        const nextStatus =
          isClosedUpstream && !keepLocalStatus && existing.status === 'new' ? 'ignored' : existing.status;

        await existing.update({ ...attributes, status: nextStatus });
        result.updated += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${repository.pathWithNamespace}#${issue.iid}: ${message}`);
      }
    }

    await link.update({ lastSyncedAt: new Date(), lastError: result.errors[0] ?? null });
    return result;
  }
}
