import { AgentTask } from '../../app-agentiz/models/AgentTask';
import type { AgentProject } from '../../app-agentiz/models/AgentProject';
import { AgentProjectIntegration } from '../models/AgentProjectIntegration';
import { GitlabConnection } from '../models/GitlabConnection';
import { GitlabRepository } from '../models/GitlabRepository';
import { GitlabOAuthService } from './GitlabOAuthService';
import type { GitlabIssue } from '../lib/GitlabApiClient';
import { buildTaskExternalId, TASK_INTEGRATION_RAW_KEY, type TaskIntegrationRef } from '../types/gitlab';

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
 * Mirrors issues of every repository linked to a project into AgentTask.
 *
 * Because one Agentiz project can aggregate many repositories, task external ids are namespaced
 * (`gl-<gitlabProjectId>-<iid>`) and every task keeps a back-reference to its integration in `raw`,
 * which is what lets the pipeline later comment/commit into the right repository.
 */
export class GitlabIssueSyncService {
  static async syncIntegration(integrationId: string, options: { force?: boolean } = {}): Promise<IssueSyncResult> {
    const integration = await AgentProjectIntegration.findByPk(integrationId);
    if (!integration) throw new Error(`Project integration ${integrationId} not found`);
    return this.syncOne(integration, options);
  }

  /** Every active issue-source link of a project. Registered as an app-agentiz sync contributor. */
  static async syncProject(project: AgentProject, options: { force?: boolean } = {}): Promise<IssueSyncResult> {
    const integrations = await AgentProjectIntegration.findAll({
      where: { projectId: project.id, provider: 'gitlab', isActive: true },
    });

    const result = emptyResult();
    for (const integration of integrations) {
      try {
        mergeInto(result, await this.syncOne(integration, options));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`integration ${integration.id}: ${message}`);
      }
    }
    return result;
  }

  static async syncAll(options: { force?: boolean } = {}): Promise<IssueSyncResult> {
    const integrations = await AgentProjectIntegration.findAll({
      where: { provider: 'gitlab', isActive: true },
    });

    const result = emptyResult();
    for (const integration of integrations) {
      try {
        mergeInto(result, await this.syncOne(integration, options));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`integration ${integration.id}: ${message}`);
      }
    }
    return result;
  }

  private static isDue(integration: AgentProjectIntegration, force: boolean): boolean {
    if (force) return true;
    const interval = integration.config?.pollIntervalSec ?? 0;
    if (!interval || !integration.lastSyncedAt) return true;
    return integration.lastSyncedAt.getTime() + interval * 1000 <= Date.now();
  }

  private static async syncOne(
    integration: AgentProjectIntegration,
    options: { force?: boolean },
  ): Promise<IssueSyncResult> {
    const result = emptyResult();

    if (!integration.isActive || !integration.syncIssues) return result;
    if (integration.role === 'target') return result;
    if (!this.isDue(integration, options.force ?? false)) return result;

    const repository = await GitlabRepository.findByPk(integration.repositoryId);
    const connection = await GitlabConnection.findByPk(integration.connectionId);
    if (!repository || !connection) {
      const message = 'linked repository or connection is missing';
      await integration.update({ lastError: message });
      result.errors.push(message);
      return result;
    }

    let issues: GitlabIssue[];
    try {
      const client = await GitlabOAuthService.apiClientFor(connection);
      issues = await client.listIssues(repository.gitlabProjectId, {
        updatedAfter: integration.lastSyncedAt ?? undefined,
        query: integration.config?.query,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await integration.update({ lastError: message });
      result.errors.push(`${repository.pathWithNamespace}: ${message}`);
      return result;
    }

    result.fetched = issues.length;

    for (const issue of issues) {
      try {
        const ref: TaskIntegrationRef = {
          provider: 'gitlab',
          integrationId: integration.id,
          connectionId: connection.id,
          repositoryId: repository.id,
          gitlabProjectId: repository.gitlabProjectId,
          issueIid: issue.iid,
        };
        const externalId = buildTaskExternalId(repository.gitlabProjectId, issue.iid);
        const attributes = {
          externalUrl: issue.web_url,
          title: issue.title,
          description: issue.description ?? '',
          tags: issue.labels ?? [],
          externalStatus: issue.state,
          // Origin of the task, so the Agentiz tracker can name the system it came from. There is
          // no AgentTaskSource row behind an OAuth integration, hence sourceId stays null.
          sourceId: null as string | null,
          sourceType: 'gitlab',
          sourceName: `GitLab Issues · ${repository.pathWithNamespace}`,
          raw: { ...(issue as unknown as Record<string, unknown>), [TASK_INTEGRATION_RAW_KEY]: ref },
          lastSyncedAt: new Date(),
        };

        const existing = await AgentTask.findOne({
          where: { projectId: integration.projectId, externalId },
        });

        if (!existing) {
          await AgentTask.create({ projectId: integration.projectId, externalId, status: 'new', ...attributes });
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

    await integration.update({ lastSyncedAt: new Date(), lastError: result.errors[0] ?? null });
    return result;
  }
}
