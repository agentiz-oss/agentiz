import { GitProvider } from './GitProvider';
import { GitHubProvider } from './GitHubProvider';
import { GitLabProvider } from './GitLabProvider';
import type { AgentProject } from '../../models/AgentProject';

export { GitProvider, GitHubProvider, GitLabProvider };
export type {
  GitCredentials,
  NormalizedExternalTask,
  FileChange,
  CommitResult,
  PullRequestResult,
  ListTasksParams,
  CommitChangesParams,
  OpenPullRequestParams,
} from './GitProvider';

/**
 * Builds the concrete provider for a project. Adding a third platform (Gitea, Jira, ...) means
 * adding a subclass of GitProvider and one case here — nothing else in the app changes.
 */
export function createGitProvider(project: AgentProject): GitProvider {
  const token = project.secrets?.token;
  if (!token) {
    throw new Error(`Project ${project.slug}: secrets.token is required to talk to ${project.repoProvider}`);
  }
  if (!project.repoConfig?.owner || !project.repoConfig?.repo) {
    throw new Error(`Project ${project.slug}: repoConfig.owner and repoConfig.repo are required`);
  }

  switch (project.repoProvider) {
    case 'github':
      return new GitHubProvider('github', project.repoConfig, { token });
    case 'gitlab':
      return new GitLabProvider('gitlab', project.repoConfig, { token });
    default:
      throw new Error(`Unsupported repoProvider: ${String(project.repoProvider)}`);
  }
}
