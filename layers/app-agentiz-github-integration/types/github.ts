/**
 * Shared domain types for app-agentiz-github-integration.
 *
 * The layer holds only what is GitHub-shaped: the OAuth *application* registered in GitHub (or a
 * GitHub Enterprise instance) and the conventions for naming GitHub issues inside Agentiz. The
 * authorized account, the mirrored repository and the project link are core models
 * (`AgentGitConnection` / `AgentRepository` / `AgentProjectRepository`).
 */

export interface GithubOAuthAppSecrets {
  clientSecret?: string;
}

export const DEFAULT_GITHUB_BASE_URL = 'https://github.com';

/**
 * `repo` is the narrowest scope that still allows reading private repositories and pushing to
 * them, which is what a pipeline does. See the note in
 * `.ai-notes/multi-repo-oauth/02-github-oauth-layer.md` §2.8: it is a *user-wide* scope, and
 * Agentiz's own repository allowlist does not narrow the token itself.
 */
export const DEFAULT_GITHUB_SCOPES = ['repo', 'read:user', 'read:org'];

/**
 * Two different roots, and mixing them up is the easiest mistake here:
 *
 *  - the **site** root (`https://github.com`, `https://ghe.company.tld`) is where the OAuth dance
 *    happens and what `GithubOAuthApp.baseUrl` stores;
 *  - the **API** root (`https://api.github.com`, `https://ghe.company.tld/api/v3`) is what REST
 *    calls use, and it is what `AgentGitConnection.baseUrl` stores, because `GitHubProvider`
 *    treats `repo.baseUrl` as an API base.
 */
export function apiBaseFor(siteBaseUrl: string): string {
  const site = siteBaseUrl.replace(/\/+$/, '');
  if (/^https?:\/\/(www\.)?github\.com$/i.test(site)) return 'https://api.github.com';
  return site.endsWith('/api/v3') ? site : `${site}/api/v3`;
}

/**
 * Issue numbers are only unique per repository, but `AgentTask.externalId` is unique per Agentiz
 * project — which may aggregate many repositories. Tasks are therefore namespaced, exactly like
 * GitLab's `gl-<projectId>-<iid>`.
 */
export function buildTaskExternalId(repoId: number | string, issueNumber: number | string): string {
  return `gh-${repoId}-${issueNumber}`;
}

export interface ParsedTaskExternalId {
  repoId: string;
  issueNumber: string;
}

export function parseTaskExternalId(externalId: string): ParsedTaskExternalId | null {
  const match = /^gh-(\d+)-(\d+)$/.exec(externalId);
  if (!match) return null;
  return { repoId: match[1], issueNumber: match[2] };
}

/**
 * Marker written into `AgentTask.raw` under the core's `TASK_REPOSITORY_RAW_KEY`. `integrationId`
 * is the `AgentProjectRepository.id`; the field name is shared with the GitLab layer because the
 * core reads it without knowing which platform wrote it.
 */
export interface TaskRepositoryRef {
  provider: 'github';
  integrationId: string;
  connectionId: string;
  repositoryId: string;
  githubRepoId: number;
  issueNumber: number;
}

/** `owner/name` -> the two halves both REST clients want. */
export function splitFullName(fullName: string): { owner: string; repo: string } {
  const index = fullName.lastIndexOf('/');
  if (index < 0) return { owner: '', repo: fullName };
  return { owner: fullName.slice(0, index), repo: fullName.slice(index + 1) };
}
