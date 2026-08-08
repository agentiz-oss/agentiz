/**
 * Shared domain types for app-agentiz-gitlab-integration.
 *
 * What is left here after the repository model moved into app-agentiz is exactly the part that is
 * GitLab-shaped: the OAuth *application* registered in a GitLab instance, and the conventions for
 * naming GitLab issues inside Agentiz.
 *
 * The authorized account (`AgentGitConnection`), the mirrored repository (`AgentRepository`) and the
 * project link (`AgentProjectRepository`) are core models — a repository id has to mean the same
 * thing to the runner allowlist, the job snapshot and the stored diff, whichever platform it is on.
 */

export interface GitlabOAuthAppSecrets {
  clientSecret?: string;
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
 * Marker written into `AgentTask.raw` under the core's `TASK_REPOSITORY_RAW_KEY` so a task can be
 * traced back to the link it came from. `integrationId` is the `AgentProjectRepository.id`; the
 * name is historical and is read from tasks synced long before that model existed.
 */
export interface TaskIntegrationRef {
  provider: 'gitlab';
  integrationId: string;
  connectionId: string;
  repositoryId: string;
  gitlabProjectId: number;
  issueIid: number;
}

/** `group/subgroup/repo` -> owner `group/subgroup`, repo `repo` (GitLab allows nested groups). */
export function splitPathWithNamespace(pathWithNamespace: string): { owner: string; repo: string } {
  const index = pathWithNamespace.lastIndexOf('/');
  if (index < 0) return { owner: '', repo: pathWithNamespace };
  return { owner: pathWithNamespace.slice(0, index), repo: pathWithNamespace.slice(index + 1) };
}
