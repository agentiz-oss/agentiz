import { AgentGitConnection } from '../../app-agentiz/models/AgentGitConnection';
import { AgentRepository } from '../../app-agentiz/models/AgentRepository';
import type { GitConnectionAuthority, RepositorySyncResult } from '../../app-agentiz/lib/git';
import { GitlabOAuthService } from './GitlabOAuthService';
import { splitPathWithNamespace } from '../types/gitlab';

export type { RepositorySyncResult };

/**
 * "Синхронизировали проекты" — pulls every GitLab project the connection can reach into
 * `AgentRepository`, so linking a repository to an Agentiz project becomes a local pick.
 */
export class GitlabRepositorySyncService {
  static async syncConnection(connectionId: string): Promise<RepositorySyncResult> {
    const connection = await AgentGitConnection.findByPk(connectionId);
    if (!connection) throw new Error(`GitLab connection ${connectionId} not found`);
    return this.sync(connection);
  }

  static async sync(connection: AgentGitConnection): Promise<RepositorySyncResult> {
    const result: RepositorySyncResult = { connectionId: connection.id, fetched: 0, created: 0, updated: 0, errors: [] };

    let projects;
    try {
      const client = await GitlabOAuthService.apiClientFor(connection);
      projects = await client.listMemberProjects();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(message);
      await connection.update({ lastError: message });
      return result;
    }

    result.fetched = projects.length;

    for (const project of projects) {
      try {
        const { owner, repo } = splitPathWithNamespace(project.path_with_namespace);
        const attributes = {
          provider: 'gitlab' as const,
          externalRepoId: String(project.id),
          pathWithNamespace: project.path_with_namespace,
          owner,
          repo,
          name: project.name,
          webUrl: project.web_url,
          // GitLab reports http_url_to_repo; fall back to the web URL, which is how the old rows
          // were migrated, so both paths agree.
          cloneUrl: (project as { http_url_to_repo?: string }).http_url_to_repo
            ?? (project.web_url ? `${project.web_url.replace(/\/$/, '')}.git` : null),
          defaultBranch: project.default_branch,
          visibility: project.visibility,
          description: project.description,
          issuesEnabled: project.issues_enabled ?? true,
          lastActivityAt: project.last_activity_at ? new Date(project.last_activity_at) : null,
          raw: project as unknown as Record<string, unknown>,
        };

        const existing = await AgentRepository.findOne({
          where: { connectionId: connection.id, externalRepoId: String(project.id) },
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
        result.errors.push(`${project.path_with_namespace}: ${message}`);
      }
    }

    await connection.update({ lastSyncedAt: new Date(), lastError: result.errors[0] ?? null });
    console.log(
      `[app-agentiz-gitlab-integration] synced repositories for connection ${connection.username ?? connection.id}: ` +
        `fetched=${result.fetched} created=${result.created} updated=${result.updated} errors=${result.errors.length}`,
    );
    return result;
  }

  static async syncAllActiveConnections(): Promise<RepositorySyncResult[]> {
    const connections = await AgentGitConnection.findAll({ where: { provider: 'gitlab', status: 'active' } });
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
 * What the core calls when it holds a GitLab connection and needs a live token or a fresh mirror.
 *
 * This is the whole contract between `AgentGitConnection` (core-owned row) and the OAuth machinery
 * that can actually renew it (layer-owned). Unmounting this layer leaves the rows in place and
 * makes `requireGitConnectionAuthority('gitlab')` say so by name.
 */
export const gitlabConnectionAuthority: GitConnectionAuthority = {
  provider: 'gitlab',
  // OAuth access tokens are only accepted as Bearer; PRIVATE-TOKEN is for personal access tokens.
  authScheme: 'bearer',
  accessToken: (connection) => GitlabOAuthService.getAccessToken(connection),
  syncRepositories: (connection) => GitlabRepositorySyncService.sync(connection),
  disconnect: async (connection) => {
    await GitlabOAuthService.disconnect(connection.id);
  },
};
