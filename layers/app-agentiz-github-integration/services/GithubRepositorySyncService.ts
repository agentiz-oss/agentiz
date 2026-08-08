import { AgentGitConnection } from '../../app-agentiz/models/AgentGitConnection';
import { AgentRepository } from '../../app-agentiz/models/AgentRepository';
import type { GitConnectionAuthority, RepositorySyncResult } from '../../app-agentiz/lib/git';
import { GithubOAuthService } from './GithubOAuthService';
import { splitFullName } from '../types/github';

export type { RepositorySyncResult };

/**
 * Pulls every repository the connection can reach into `AgentRepository`, so linking one to an
 * Agentiz project is a local pick instead of an API call per render.
 */
export class GithubRepositorySyncService {
  static async syncConnection(connectionId: string): Promise<RepositorySyncResult> {
    const connection = await AgentGitConnection.findByPk(connectionId);
    if (!connection) throw new Error(`GitHub connection ${connectionId} not found`);
    return this.sync(connection);
  }

  static async sync(connection: AgentGitConnection): Promise<RepositorySyncResult> {
    const result: RepositorySyncResult = { connectionId: connection.id, fetched: 0, created: 0, updated: 0, errors: [] };

    let repos;
    try {
      const client = await GithubOAuthService.apiClientFor(connection);
      repos = await client.listAccessibleRepos();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(message);
      await connection.update({ lastError: message });
      return result;
    }

    result.fetched = repos.length;

    for (const repo of repos) {
      try {
        const fallback = splitFullName(repo.full_name);
        const attributes = {
          provider: 'github' as const,
          externalRepoId: String(repo.id),
          pathWithNamespace: repo.full_name,
          owner: repo.owner?.login ?? fallback.owner,
          repo: repo.name ?? fallback.repo,
          name: repo.name,
          webUrl: repo.html_url,
          cloneUrl: repo.clone_url,
          defaultBranch: repo.default_branch,
          visibility: repo.private ? 'private' : 'public',
          description: repo.description,
          issuesEnabled: repo.has_issues ?? true,
          lastActivityAt: repo.pushed_at ? new Date(repo.pushed_at) : null,
          raw: repo as unknown as Record<string, unknown>,
        };

        const existing = await AgentRepository.findOne({
          where: { connectionId: connection.id, externalRepoId: String(repo.id) },
        });

        if (existing) {
          await existing.update(attributes);
          result.updated += 1;
        } else {
          await AgentRepository.create({ connectionId: connection.id, ...attributes });
          result.created += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${repo.full_name}: ${message}`);
      }
    }

    await connection.update({ lastSyncedAt: new Date(), lastError: result.errors[0] ?? null });
    console.log(
      `[app-agentiz-github-integration] synced repositories for connection ${connection.username ?? connection.id}: ` +
        `fetched=${result.fetched} created=${result.created} updated=${result.updated} errors=${result.errors.length}`,
    );
    return result;
  }

  static async syncAllActiveConnections(): Promise<RepositorySyncResult[]> {
    const connections = await AgentGitConnection.findAll({ where: { provider: 'github', status: 'active' } });
    const results: RepositorySyncResult[] = [];
    for (const connection of connections) {
      try {
        results.push(await this.sync(connection));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ connectionId: connection.id, fetched: 0, created: 0, updated: 0, errors: [message] });
      }
    }
    return results;
  }
}

/**
 * What the core calls when it holds a GitHub connection and needs a live token or a fresh mirror.
 *
 * Simpler than the GitLab side in one respect: `GitHubProvider` always sends
 * `Authorization: Bearer`, so an OAuth token and a personal access token take the same header and
 * no provider subclass is needed.
 */
export const githubConnectionAuthority: GitConnectionAuthority = {
  provider: 'github',
  authScheme: 'bearer',
  accessToken: (connection) => GithubOAuthService.getAccessToken(connection),
  syncRepositories: (connection) => GithubRepositorySyncService.sync(connection),
  disconnect: async (connection) => {
    await GithubOAuthService.disconnect(connection.id);
  },
};
