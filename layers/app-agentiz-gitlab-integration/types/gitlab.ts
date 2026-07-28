/**
 * Shared domain types for app-agentiz-gitlab-integration.
 *
 * The layer is built around three nested things:
 *   GitlabOAuthApp  — the OAuth *application* registered in a GitLab instance (client id/secret);
 *   GitlabConnection — one authorized GitLab account (access/refresh token) of such an application;
 *   GitlabRepository — a GitLab project reachable through that connection.
 * AgentProjectIntegration then links any number of repositories (from any number of connections
 * and instances) to a single Agentiz project.
 */

export type GitlabConnectionStatus = 'active' | 'expired' | 'revoked' | 'error';

/** What a linked repository is used for inside the pipeline. */
export type IntegrationRole = 'source' | 'target' | 'both';

export interface GitlabOAuthAppSecrets {
  clientSecret?: string;
}

export interface GitlabConnectionSecrets {
  accessToken?: string;
  refreshToken?: string;
}

export interface AgentProjectIntegrationConfig {
  /** Minimum seconds between issue syncs of this link; 0/absent = every scheduled tick. */
  pollIntervalSec?: number;
  /** Raw passthrough filter for GET /projects/:id/issues (state, labels, milestone, ...). */
  query?: Record<string, unknown>;
  /** Branch commits are based on; falls back to the repository's default branch. */
  defaultBranch?: string;
}

export const DEFAULT_GITLAB_BASE_URL = 'https://gitlab.com';

export const DEFAULT_GITLAB_SCOPES = ['api', 'read_user', 'read_repository', 'write_repository'];

/**
 * Issue iids are only unique per GitLab project, but AgentTask.externalId is unique per Agentiz
 * project — which may now aggregate many repositories. Tasks are therefore namespaced.
 */
export function buildTaskExternalId(gitlabProjectId: number | string, issueIid: number | string): string {
  return `gl-${gitlabProjectId}-${issueIid}`;
}

export interface ParsedTaskExternalId {
  gitlabProjectId: string;
  issueIid: string;
}

export function parseTaskExternalId(externalId: string): ParsedTaskExternalId | null {
  const match = /^gl-(\d+)-(\d+)$/.exec(externalId);
  if (!match) return null;
  return { gitlabProjectId: match[1], issueIid: match[2] };
}

/**
 * Marker written into AgentTask.raw so the task can be traced back to the integration (and
 * therefore to the repository and token) it came from, without touching the app-agentiz schema.
 */
export const TASK_INTEGRATION_RAW_KEY = 'agentizIntegration';

export interface TaskIntegrationRef {
  provider: 'gitlab';
  integrationId: string;
  connectionId: string;
  repositoryId: string;
  gitlabProjectId: number;
  issueIid: number;
}

export function readTaskIntegrationRef(raw: unknown): TaskIntegrationRef | null {
  const ref = (raw as Record<string, unknown> | null | undefined)?.[TASK_INTEGRATION_RAW_KEY];
  if (!ref || typeof ref !== 'object') return null;
  const candidate = ref as Partial<TaskIntegrationRef>;
  return candidate.integrationId && candidate.repositoryId ? (candidate as TaskIntegrationRef) : null;
}

/** `group/subgroup/repo` -> owner `group/subgroup`, repo `repo` (GitLab allows nested groups). */
export function splitPathWithNamespace(pathWithNamespace: string): { owner: string; repo: string } {
  const index = pathWithNamespace.lastIndexOf('/');
  if (index < 0) return { owner: '', repo: pathWithNamespace };
  return { owner: pathWithNamespace.slice(0, index), repo: pathWithNamespace.slice(index + 1) };
}
