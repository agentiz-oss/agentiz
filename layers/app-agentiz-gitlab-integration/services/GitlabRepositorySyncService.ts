import { GitlabConnection } from '../models/GitlabConnection';
import { GitlabRepository } from '../models/GitlabRepository';
import { GitlabOAuthService } from './GitlabOAuthService';

export interface RepositorySyncResult {
  connectionId: string;
  fetched: number;
  created: number;
  updated: number;
  errors: string[];
}

/**
 * "Синхронизировали проекты" — pulls every GitLab project the connection can reach into
 * GitlabRepository, so linking a repository to an Agentiz project becomes a local pick.
 */
export class GitlabRepositorySyncService {
  static async syncConnection(connectionId: string): Promise<RepositorySyncResult> {
    const connection = await GitlabConnection.findByPk(connectionId);
    if (!connection) throw new Error(`GitLab connection ${connectionId} not found`);

    const result: RepositorySyncResult = { connectionId, fetched: 0, created: 0, updated: 0, errors: [] };

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
        const attributes = {
          gitlabProjectId: project.id,
          pathWithNamespace: project.path_with_namespace,
          name: project.name,
          webUrl: project.web_url,
          defaultBranch: project.default_branch,
          visibility: project.visibility,
          description: project.description,
          issuesEnabled: project.issues_enabled ?? true,
          lastActivityAt: project.last_activity_at ? new Date(project.last_activity_at) : null,
          raw: project as unknown as Record<string, unknown>,
        };

        const existing = await GitlabRepository.findOne({
          where: { connectionId: connection.id, gitlabProjectId: project.id },
        });

        if (existing) {
          await existing.update(attributes);
          result.updated += 1;
        } else {
          await GitlabRepository.create({ connectionId: connection.id, ...attributes });
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
    const connections = await GitlabConnection.findAll({ where: { status: 'active' } });
    const results: RepositorySyncResult[] = [];
    for (const connection of connections) {
      try {
        results.push(await this.syncConnection(connection.id));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ connectionId: connection.id, fetched: 0, created: 0, updated: 0, errors: [message] });
      }
    }
    return results;
  }
}
