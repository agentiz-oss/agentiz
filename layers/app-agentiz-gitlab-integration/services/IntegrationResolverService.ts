import type { AgentProject } from '../../app-agentiz/models/AgentProject';
import type { AgentTask } from '../../app-agentiz/models/AgentTask';
import type { GitProvider, TaskRepositoryRef } from '../../app-agentiz/lib/git';
import { AgentProjectIntegration } from '../models/AgentProjectIntegration';
import { GitlabConnection } from '../models/GitlabConnection';
import { GitlabOAuthApp } from '../models/GitlabOAuthApp';
import { GitlabRepository } from '../models/GitlabRepository';
import { IntegrationGitLabProvider } from '../lib/IntegrationGitLabProvider';
import { GitlabOAuthService } from './GitlabOAuthService';
import { parseTaskExternalId, readTaskIntegrationRef, splitPathWithNamespace } from '../types/gitlab';

interface ResolvedIntegration {
  integration: AgentProjectIntegration;
  repository: GitlabRepository;
  connection: GitlabConnection;
  oauthApp: GitlabOAuthApp;
}

/**
 * Answers "which external repository does this task belong to?" for app-agentiz.
 *
 * A task knows its integration through the marker written into `raw` at sync time; tasks created
 * before a link existed (or by hand) fall back to matching the namespaced external id, and finally
 * to the project's primary link. Returning null means "not ours" — app-agentiz then uses the
 * project's own repoConfig.
 */
export class IntegrationResolverService {
  static async resolveForTask(task: AgentTask, project: AgentProject): Promise<ResolvedIntegration | null> {
    const integration = await this.findIntegration(task, project);
    if (!integration) return null;

    const repository = await GitlabRepository.findByPk(integration.repositoryId);
    const connection = await GitlabConnection.findByPk(integration.connectionId);
    if (!repository || !connection) return null;

    const oauthApp = await GitlabOAuthApp.findByPk(connection.oauthAppId);
    if (!oauthApp) return null;

    return { integration, repository, connection, oauthApp };
  }

  private static async findIntegration(
    task: AgentTask,
    project: AgentProject,
  ): Promise<AgentProjectIntegration | null> {
    const ref = readTaskIntegrationRef(task.raw);
    if (ref) {
      const byRef = await AgentProjectIntegration.findByPk(ref.integrationId);
      if (byRef && byRef.isActive) return byRef;
    }

    const parsed = parseTaskExternalId(task.externalId);
    if (parsed) {
      const repositories = await GitlabRepository.findAll({
        where: { gitlabProjectId: Number(parsed.gitlabProjectId) },
      });
      for (const repository of repositories) {
        const link = await AgentProjectIntegration.findOne({
          where: { projectId: project.id, repositoryId: repository.id, isActive: true },
        });
        if (link) return link;
      }
      return null;
    }

    // Tasks with a plain external id belong to the project's own repo unless it has a primary link
    // and no repo configuration of its own.
    if (project.repoConfig?.owner && project.repoConfig?.repo) return null;
    return AgentProjectIntegration.findOne({
      where: { projectId: project.id, provider: 'gitlab', isActive: true, isPrimary: true },
    });
  }

  /** app-agentiz TaskGitProviderResolver: a provider bound to the task's linked repository. */
  static async resolveProvider(task: AgentTask, project: AgentProject): Promise<GitProvider | null> {
    const resolved = await this.resolveForTask(task, project);
    if (!resolved) return null;

    const { repository, connection, oauthApp, integration } = resolved;
    if (integration.role === 'source') return null; // issue source only, never commit here

    const { owner, repo } = splitPathWithNamespace(repository.pathWithNamespace);
    const accessToken = await GitlabOAuthService.getAccessToken(connection);

    return new IntegrationGitLabProvider(
      'gitlab',
      {
        owner,
        repo,
        baseUrl: oauthApp.baseUrl,
        defaultBranch: integration.config?.defaultBranch ?? repository.defaultBranch ?? undefined,
      },
      { token: accessToken, authScheme: 'bearer' },
    );
  }

  /** app-agentiz TaskRepositoryResolver: what the worker has to clone for this task. */
  static async resolveRepository(task: AgentTask, project: AgentProject): Promise<TaskRepositoryRef | null> {
    const resolved = await this.resolveForTask(task, project);
    if (!resolved) return null;

    const { repository, oauthApp, integration } = resolved;
    const { owner, repo } = splitPathWithNamespace(repository.pathWithNamespace);
    return {
      provider: 'gitlab',
      baseUrl: oauthApp.baseUrl,
      owner,
      repo,
      defaultBranch: integration.config?.defaultBranch ?? repository.defaultBranch ?? undefined,
    };
  }
}
