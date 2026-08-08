import { GitProvider } from './GitProvider';
import { GitHubProvider } from './GitHubProvider';
import type { GitCredentials } from './GitProvider';
import type { AgentProject } from '../../models/AgentProject';
import type { AgentTask } from '../../models/AgentTask';
import type { AgentProjectRepoConfig, GitProviderType } from '../../types/agentiz';

export { GitProvider, GitHubProvider };
export { mergeFileOps, normalizeFileChanges } from './GitProvider';
export {
  getGitConnectionAuthority,
  listGitConnectionProviders,
  registerGitConnectionAuthority,
  requireGitConnectionAuthority,
  unregisterGitConnectionAuthority,
} from './connections';
export type { GitConnectionAuthority, RepositorySyncResult } from './connections';
export type {
  GitCredentials,
  NormalizedExternalTask,
  NormalizedExternalComment,
  CommentResult,
  FileChange,
  FileMode,
  FileOp,
  StageChangeSet,
  CommitResult,
  PullRequestResult,
  ListTasksParams,
  CommitChangesParams,
  OpenPullRequestParams,
  ResolvedRef,
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
  /**
   * Reads a namespaced `AgentTask.externalId` back into "which repository, which issue".
   *
   * One Agentiz project aggregates repositories, so an issue number alone is not unique and each
   * platform namespaces it its own way (`gl-<projectId>-<iid>`, `gh-<repoId>-<number>`). Only the
   * layer knows its format, so the core asks instead of parsing; returning null means "not mine".
   */
  parseTaskExternalId?(externalId: string): { externalRepoId: string; issueId: string } | null;
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
  /**
   * `gh-<repoId>-<number>`, written by the GitHub integration layer when a task comes from a linked
   * repository. A bare issue number is not namespaced and returns null, which is correct: such a
   * task belongs to the project's own repoConfig.
   */
  parseTaskExternalId: (externalId) => {
    const match = /^gh-(\d+)-(\d+)$/.exec(externalId);
    return match ? { externalRepoId: match[1], issueId: match[2] } : null;
  },
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

/**
 * Parked on a global symbol for the same reason as the adapter map above: under tsx this file can
 * be instantiated twice (once through the ESM graph, once through CJS), and plain module state
 * would then split in two — a resolver registered by app-agentiz would be invisible to
 * createGitProviderForTask, which silently falls back to the project's own repoConfig and reports
 * "task has no repository" for a task that has one.
 */
const PROVIDER_RESOLVERS_KEY = Symbol.for('agentiz.taskGitProviderResolvers');
const resolverScope = globalThis as unknown as Record<symbol, Map<string, any> | undefined>;
const taskProviderResolvers: Map<string, TaskGitProviderResolver> =
  (resolverScope[PROVIDER_RESOLVERS_KEY] as Map<string, TaskGitProviderResolver> | undefined)
  ?? (resolverScope[PROVIDER_RESOLVERS_KEY] = new Map());

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

/**
 * Branch declared by a task tag: `branch:feature/x`. The first one wins.
 *
 * The prefix is matched case-insensitively, the branch name is not — git is case sensitive, and
 * lowercasing `feature/JIRA-12` would produce a ref that does not exist.
 */
export function branchFromTags(tags: string[] | null | undefined): string | null {
  for (const tag of tags ?? []) {
    const match = /^branch:(.+)$/i.exec(String(tag).trim());
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return null;
}

/** Where a task's code lives — what the worker has to clone. */
export interface TaskRepositoryRef {
  provider: GitProviderType;
  baseUrl?: string;
  owner: string;
  repo: string;
  defaultBranch?: string;
  /** `AgentRepository.id` when the task resolved through a linked repository. */
  repositoryId?: string;
  /** Clone URL as the platform reports it; absent for a project's own repoConfig. */
  cloneUrl?: string;
}

export type TaskRepositoryResolver = (
  task: AgentTask,
  project: AgentProject,
) => Promise<TaskRepositoryRef | null> | TaskRepositoryRef | null;

const REPOSITORY_RESOLVERS_KEY = Symbol.for('agentiz.taskRepositoryResolvers');
const taskRepositoryResolvers: Map<string, TaskRepositoryResolver> =
  (resolverScope[REPOSITORY_RESOLVERS_KEY] as Map<string, TaskRepositoryResolver> | undefined)
  ?? (resolverScope[REPOSITORY_RESOLVERS_KEY] = new Map());

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
