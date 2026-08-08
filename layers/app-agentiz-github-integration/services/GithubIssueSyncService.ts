import { AgentTask } from '../../app-agentiz/models/AgentTask';
import type { AgentProject } from '../../app-agentiz/models/AgentProject';
import { AgentGitConnection } from '../../app-agentiz/models/AgentGitConnection';
import { AgentProjectRepository } from '../../app-agentiz/models/AgentProjectRepository';
import { AgentRepository } from '../../app-agentiz/models/AgentRepository';
import { TASK_REPOSITORY_RAW_KEY } from '../../app-agentiz/services/RepositoryResolverService';
import { GithubOAuthService } from './GithubOAuthService';
import type { GithubIssue } from '../lib/GithubApiClient';
import { buildTaskExternalId, type TaskRepositoryRef } from '../types/github';

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
 * Mirrors issues of every GitHub repository linked to a project into AgentTask.
 *
 * The GitHub *task manager* adapter in the core does the same job for a project configured with a
 * personal access token; this one is the OAuth path, where tasks come from links and carry a
 * namespaced external id (`gh-<repoId>-<number>`) plus a back-reference to the link they came from.
 */
export class GithubIssueSyncService {
  static async syncLink(linkId: string, options: { force?: boolean } = {}): Promise<IssueSyncResult> {
    const link = await AgentProjectRepository.findByPk(linkId);
    if (!link) throw new Error(`Project repository link ${linkId} not found`);
    return this.syncOne(link, options);
  }

  /** Every active task-source link of a project. Registered as an app-agentiz sync contributor. */
  static async syncProject(project: AgentProject, options: { force?: boolean } = {}): Promise<IssueSyncResult> {
    return this.syncMany(
      await AgentProjectRepository.findAll({ where: { projectId: project.id, provider: 'github', isActive: true } }),
      options,
    );
  }

  static async syncAll(options: { force?: boolean } = {}): Promise<IssueSyncResult> {
    return this.syncMany(
      await AgentProjectRepository.findAll({ where: { provider: 'github', isActive: true } }),
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

    let issues: GithubIssue[];
    try {
      const client = await GithubOAuthService.apiClientFor(connection);
      issues = await client.listIssues(repository.owner, repository.repo, {
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
        const ref: TaskRepositoryRef = {
          provider: 'github',
          integrationId: link.id,
          connectionId: connection.id,
          repositoryId: repository.id,
          githubRepoId: Number(repository.externalRepoId),
          issueNumber: issue.number,
        };
        const externalId = buildTaskExternalId(repository.externalRepoId, issue.number);
        const attributes = {
          externalUrl: issue.html_url,
          title: issue.title,
          description: issue.body ?? '',
          tags: issue.labels.map((label) => (typeof label === 'string' ? label : label.name)),
          externalStatus: issue.state,
          // No AgentTaskSource row stands behind an OAuth connection, hence sourceId stays null.
          sourceId: null as string | null,
          sourceType: 'github',
          sourceName: `GitHub Issues · ${repository.pathWithNamespace}`,
          raw: { ...(issue as unknown as Record<string, unknown>), [TASK_REPOSITORY_RAW_KEY]: ref },
          lastSyncedAt: new Date(),
        };

        const existing = await AgentTask.findOne({ where: { projectId: link.projectId, externalId } });

        if (!existing) {
          await AgentTask.create({ projectId: link.projectId, externalId, status: 'new', ...attributes });
          result.created += 1;
          continue;
        }

        const isClosedUpstream = issue.state.toLowerCase() === 'closed';
        const keepLocalStatus = LOCALLY_OWNED_STATUSES.has(existing.status);
        const nextStatus =
          isClosedUpstream && !keepLocalStatus && existing.status === 'new' ? 'ignored' : existing.status;

        await existing.update({ ...attributes, status: nextStatus });
        result.updated += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${repository.pathWithNamespace}#${issue.number}: ${message}`);
      }
    }

    await link.update({ lastSyncedAt: new Date(), lastError: result.errors[0] ?? null });
    return result;
  }
}
