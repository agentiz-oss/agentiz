import type { AgentProject } from '../models/AgentProject';
import type { AgentTask } from '../models/AgentTask';
import { AgentGitConnection } from '../models/AgentGitConnection';
import { AgentProjectRepository } from '../models/AgentProjectRepository';
import { AgentRepository } from '../models/AgentRepository';
import {
  createGitProviderFor,
  getGitProviderAdapter,
  listGitProviderTypes,
  requireGitConnectionAuthority,
} from '../lib/git';
import type { GitProvider, TaskRepositoryRef } from '../lib/git';
import type { GitProviderType } from '../types/agentiz';

export interface ResolvedRepository {
  link: AgentProjectRepository;
  repository: AgentRepository;
  connection: AgentGitConnection;
}

/**
 * Marker written into `AgentTask.raw` at sync time so a task can be traced back to the link (and
 * therefore to the repository and the token) it came from, without adding columns to AgentTask.
 *
 * The key and the `integrationId` field name are historical — they were introduced by the GitLab
 * layer and are read from tasks synced long before this service existed. Renaming them would mean
 * rewriting every stored task for no behavioural gain.
 */
export const TASK_REPOSITORY_RAW_KEY = 'agentizIntegration';

export interface TaskRepositoryMarker {
  provider: string;
  /** Id of the AgentProjectRepository row. */
  integrationId: string;
  connectionId: string;
  repositoryId: string;
  [key: string]: unknown;
}

export function readTaskRepositoryMarker(raw: unknown): TaskRepositoryMarker | null {
  const ref = (raw as Record<string, unknown> | null | undefined)?.[TASK_REPOSITORY_RAW_KEY];
  if (!ref || typeof ref !== 'object') return null;
  const candidate = ref as Partial<TaskRepositoryMarker>;
  return candidate.integrationId && candidate.repositoryId ? (candidate as TaskRepositoryMarker) : null;
}

/**
 * Answers "which repository does this task belong to?" for the whole application.
 *
 * Registered as both a `TaskGitProviderResolver` and a `TaskRepositoryResolver`, so every caller
 * that acts on a task — comment, status push, commit, worker snapshot — lands in the repository the
 * task actually came from, with that repository's own token. Returning null means "this task is not
 * linked to anything", and the caller falls back to the project's own `repoConfig`.
 */
export class RepositoryResolverService {
  static async resolveForTask(task: AgentTask, project: AgentProject): Promise<ResolvedRepository | null> {
    const link = await this.findLink(task, project);
    if (!link) return null;

    const [repository, connection] = await Promise.all([
      AgentRepository.findByPk(link.repositoryId),
      AgentGitConnection.findByPk(link.connectionId),
    ]);
    if (!repository || !connection) return null;

    return { link, repository, connection };
  }

  /**
   * Three ways in, most specific first:
   *
   * 1. the marker in `raw` — a direct hit, written when the task was synced;
   * 2. the namespaced external id, parsed by the platform's own adapter — covers tasks synced
   *    before a marker existed, or created by hand;
   * 3. the project's primary link — only for a project that has no repository of its own, because
   *    otherwise a plain external id belongs to `repoConfig`.
   */
  private static async findLink(task: AgentTask, project: AgentProject): Promise<AgentProjectRepository | null> {
    const marker = readTaskRepositoryMarker(task.raw);
    if (marker) {
      const byMarker = await AgentProjectRepository.findByPk(marker.integrationId);
      if (byMarker?.isActive) return byMarker;
    }

    const parsed = this.parseExternalId(task.externalId);
    if (parsed) {
      const repositories = await AgentRepository.findAll({
        where: { provider: parsed.provider, externalRepoId: parsed.externalRepoId },
      });
      for (const repository of repositories) {
        const link = await AgentProjectRepository.findOne({
          where: { projectId: project.id, repositoryId: repository.id, isActive: true },
        });
        if (link) return link;
      }
      return null;
    }

    if (project.repoConfig?.owner && project.repoConfig?.repo) return null;
    return AgentProjectRepository.findOne({
      where: { projectId: project.id, isActive: true, isPrimary: true },
    });
  }

  /** Asks every mounted platform whether the id is one of theirs. */
  private static parseExternalId(
    externalId: string,
  ): { provider: GitProviderType; externalRepoId: string; issueId: string } | null {
    for (const type of listGitProviderTypes()) {
      const parsed = getGitProviderAdapter(type)?.parseTaskExternalId?.(externalId);
      if (parsed) return { provider: type, ...parsed };
    }
    return null;
  }

  /** Provider bound to a linked repository, carrying a live token for its connection. */
  static async providerFor(
    repository: AgentRepository,
    connection: AgentGitConnection,
    defaultBranch?: string | null,
  ): Promise<GitProvider> {
    const authority = requireGitConnectionAuthority(repository.provider);
    return createGitProviderFor(
      repository.provider,
      {
        owner: repository.owner,
        repo: repository.repo,
        baseUrl: connection.baseUrl ?? undefined,
        defaultBranch: defaultBranch ?? repository.defaultBranch ?? undefined,
      },
      { token: await authority.accessToken(connection), authScheme: authority.authScheme },
    );
  }

  /** app-agentiz TaskGitProviderResolver. */
  static async resolveProvider(task: AgentTask, project: AgentProject): Promise<GitProvider | null> {
    const resolved = await this.resolveForTask(task, project);
    if (!resolved) return null;
    // A `source` link is a task feed, never a commit target: writing there would push an agent's
    // work into a repository somebody deliberately marked read-only for this project.
    if (resolved.link.role === 'source') return null;
    return this.providerFor(resolved.repository, resolved.connection, resolved.link.config?.defaultBranch);
  }

  /** app-agentiz TaskRepositoryResolver: what the worker has to clone for this task. */
  static async resolveRepository(task: AgentTask, project: AgentProject): Promise<TaskRepositoryRef | null> {
    const resolved = await this.resolveForTask(task, project);
    if (!resolved) return null;
    const { repository, connection, link } = resolved;
    return {
      provider: repository.provider,
      baseUrl: connection.baseUrl ?? undefined,
      owner: repository.owner,
      repo: repository.repo,
      defaultBranch: link.config?.defaultBranch ?? repository.defaultBranch ?? undefined,
      repositoryId: repository.id,
      cloneUrl: repository.cloneUrl ?? undefined,
    };
  }

  /** Every active link of a project, with its repository and connection loaded. */
  static async listForProject(projectId: string): Promise<ResolvedRepository[]> {
    const links = await AgentProjectRepository.findAll({
      where: { projectId, isActive: true },
      order: [['createdAt', 'ASC']],
    });
    const resolved: ResolvedRepository[] = [];
    for (const link of links) {
      const [repository, connection] = await Promise.all([
        AgentRepository.findByPk(link.repositoryId),
        AgentGitConnection.findByPk(link.connectionId),
      ]);
      if (repository && connection) resolved.push({ link, repository, connection });
    }
    return resolved;
  }
}
