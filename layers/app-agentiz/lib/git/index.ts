import { GitProvider } from './GitProvider';
import { GitHubProvider } from './GitHubProvider';
import type { GitCredentials } from './GitProvider';
import type { AgentProject } from '../../models/AgentProject';
import type { AgentTask } from '../../models/AgentTask';
import type { AgentProjectRepoConfig, GitProviderType } from '../../types/agentiz';

export { GitProvider, GitHubProvider };
export type {
  GitCredentials,
  NormalizedExternalTask,
  NormalizedExternalComment,
  CommentResult,
  FileChange,
  CommitResult,
  PullRequestResult,
  ListTasksParams,
  CommitChangesParams,
  OpenPullRequestParams,
} from './GitProvider';

/**
 * Everything app-agentiz needs to know about one hosting platform: which `repoProvider` value it
 * answers to and how to build a provider for a repository.
 *
 * Adapters are not hardcoded here. Each platform lives in its own application layer and is
 * contributed through the app-manager collection `gitProviders` (see GitProviderCollection.ts),
 * so adding Gitea or Bitbucket means adding a layer, not editing the core.
 */
export interface GitProviderAdapter {
  type: GitProviderType;
  create(repo: AgentProjectRepoConfig, credentials: GitCredentials): GitProvider;
}

/**
 * type -> adapter, filled by the `gitProviders` collection handler while apps are mounted.
 *
 * The map is parked on a global symbol rather than kept as plain module state: under tsx the same
 * file can end up instantiated twice (once through the ESM graph, once through CJS), and a
 * module-level Map would then split in two — adapters registered by the handler would be invisible
 * to createGitProvider().
 */
const ADAPTERS_KEY = Symbol.for('agentiz.gitProviderAdapters');
const globalScope = globalThis as unknown as Record<symbol, Map<GitProviderType, GitProviderAdapter> | undefined>;
const providerAdapters: Map<GitProviderType, GitProviderAdapter> =
  globalScope[ADAPTERS_KEY] ?? (globalScope[ADAPTERS_KEY] = new Map());

export function registerGitProviderAdapter(adapter: GitProviderAdapter): void {
  providerAdapters.set(adapter.type, adapter);
}

export function unregisterGitProviderAdapter(type: GitProviderType): void {
  providerAdapters.delete(type);
}

export function getGitProviderAdapter(type: GitProviderType): GitProviderAdapter | undefined {
  return providerAdapters.get(type);
}

/** Platforms usable right now — i.e. whose layers are mounted. */
export function listGitProviderTypes(): GitProviderType[] {
  return [...providerAdapters.keys()];
}

/** Builds a provider for an arbitrary repository + credentials pair. */
export function createGitProviderFor(
  type: GitProviderType,
  repo: AgentProjectRepoConfig,
  credentials: GitCredentials,
): GitProvider {
  const adapter = providerAdapters.get(type);
  if (!adapter) {
    const available = listGitProviderTypes().join(', ') || 'none';
    throw new Error(
      `No git provider adapter for "${type}": the layer providing it is not mounted (available: ${available})`,
    );
  }
  return adapter.create(repo, credentials);
}

/** Builds the provider a project's own repository configuration points at. */
export function createGitProvider(project: AgentProject): GitProvider {
  const token = project.secrets?.token;
  if (!token) {
    throw new Error(`Project ${project.slug}: secrets.token is required to talk to ${project.repoProvider}`);
  }
  if (!project.repoProvider) {
    throw new Error(`Project ${project.slug}: repoProvider is not set`);
  }
  if (!project.repoConfig?.owner || !project.repoConfig?.repo) {
    throw new Error(`Project ${project.slug}: repoConfig.owner and repoConfig.repo are required`);
  }

  return createGitProviderFor(project.repoProvider, project.repoConfig, { token });
}

/** app-agentiz ships the GitHub adapter itself; GitLab comes from app-agentiz-gitlab-integration. */
export const githubProviderAdapter: GitProviderAdapter = {
  type: 'github',
  create: (repo, credentials) => new GitHubProvider('github', repo, credentials),
};

/**
 * Resolves the provider a *task* belongs to. A project may be wired to many external systems and
 * many repositories at once (see app-agentiz-gitlab-integration), in which case the project's own
 * repoConfig is not where the task came from — the owning layer registers a resolver here and
 * returns a provider bound to that task's repository.
 */
export type TaskGitProviderResolver = (
  task: AgentTask,
  project: AgentProject,
) => Promise<GitProvider | null> | GitProvider | null;

const taskProviderResolvers = new Map<string, TaskGitProviderResolver>();

export function registerTaskGitProviderResolver(appId: string, resolver: TaskGitProviderResolver): void {
  taskProviderResolvers.set(appId, resolver);
}

export function unregisterTaskGitProviderResolver(appId: string): void {
  taskProviderResolvers.delete(appId);
}

/**
 * First resolver that claims the task wins; otherwise the project's own repo configuration is used.
 * Callers that act on a task (comment, status push, commit) must go through this instead of
 * createGitProvider so multi-repository projects keep working.
 */
export async function createGitProviderForTask(task: AgentTask, project: AgentProject): Promise<GitProvider> {
  for (const resolver of taskProviderResolvers.values()) {
    const provider = await resolver(task, project);
    if (provider) return provider;
  }
  return createGitProvider(project);
}

/** Where a task's code lives — what the worker has to clone. */
export interface TaskRepositoryRef {
  provider: GitProviderType;
  baseUrl?: string;
  owner: string;
  repo: string;
  defaultBranch?: string;
}

export type TaskRepositoryResolver = (
  task: AgentTask,
  project: AgentProject,
) => Promise<TaskRepositoryRef | null> | TaskRepositoryRef | null;

const taskRepositoryResolvers = new Map<string, TaskRepositoryResolver>();

export function registerTaskRepositoryResolver(appId: string, resolver: TaskRepositoryResolver): void {
  taskRepositoryResolvers.set(appId, resolver);
}

export function unregisterTaskRepositoryResolver(appId: string): void {
  taskRepositoryResolvers.delete(appId);
}

export async function resolveTaskRepository(task: AgentTask, project: AgentProject): Promise<TaskRepositoryRef> {
  for (const resolver of taskRepositoryResolvers.values()) {
    const ref = await resolver(task, project);
    if (ref) return ref;
  }
  if (!project.repoProvider || !project.repoConfig?.owner || !project.repoConfig?.repo) {
    throw new Error(
      `Project ${project.slug}: task ${task.externalId} has no repository (neither repoConfig nor an integration)`,
    );
  }
  return {
    provider: project.repoProvider,
    baseUrl: project.repoConfig.baseUrl,
    owner: project.repoConfig.owner,
    repo: project.repoConfig.repo,
    defaultBranch: project.repoConfig.defaultBranch,
  };
}
