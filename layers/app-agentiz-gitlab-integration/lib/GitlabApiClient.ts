import { normalizeBaseUrl } from './GitlabOAuthClient';

/** Minimal GitLab REST v4 client authenticated with an OAuth access token (Bearer). */

export interface GitlabUser {
  id: number;
  username: string;
  name: string;
  avatar_url: string | null;
}

export interface GitlabProject {
  id: number;
  name: string;
  path_with_namespace: string;
  web_url: string;
  http_url_to_repo?: string | null;
  description: string | null;
  default_branch: string | null;
  visibility: string | null;
  issues_enabled?: boolean;
  last_activity_at?: string | null;
}

export interface GitlabIssue {
  iid: number;
  project_id: number;
  web_url: string;
  title: string;
  description: string | null;
  state: string;
  labels: string[];
  updated_at: string;
}

export class GitlabApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'GitlabApiError';
  }
}

export class GitlabApiClient {
  private readonly apiBase: string;

  constructor(baseUrl: string, private readonly accessToken: string) {
    this.apiBase = `${normalizeBaseUrl(baseUrl)}/api/v4`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<{ data: T; headers: Headers }> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitlabApiError(`GitLab API ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`, res.status);
    }
    const data = res.status === 204 ? (undefined as T) : ((await res.json()) as T);
    return { data, headers: res.headers };
  }

  async getCurrentUser(): Promise<GitlabUser> {
    return (await this.request<GitlabUser>('GET', '/user')).data;
  }

  /**
   * Every project the token's user is a member of. GitLab caps `per_page` at 100, so pages are
   * followed until an instance-friendly ceiling is reached.
   */
  async listMemberProjects(options: { maxPages?: number; minAccessLevel?: number } = {}): Promise<GitlabProject[]> {
    const maxPages = options.maxPages ?? 20;
    const projects: GitlabProject[] = [];

    for (let page = 1; page <= maxPages; page += 1) {
      const search = new URLSearchParams({
        membership: 'true',
        per_page: '100',
        page: String(page),
        order_by: 'last_activity_at',
        simple: 'false',
        archived: 'false',
      });
      if (options.minAccessLevel) search.set('min_access_level', String(options.minAccessLevel));

      const { data, headers } = await this.request<GitlabProject[]>('GET', `/projects?${search.toString()}`);
      projects.push(...data);

      const nextPage = headers.get('x-next-page');
      if (!nextPage || data.length === 0) break;
    }

    return projects;
  }

  async listIssues(gitlabProjectId: number | string, params: { updatedAfter?: Date; query?: Record<string, unknown> } = {}): Promise<GitlabIssue[]> {
    const search = new URLSearchParams({ per_page: '100', scope: 'all' });
    if (params.updatedAfter) search.set('updated_after', params.updatedAfter.toISOString());
    for (const [key, value] of Object.entries(params.query ?? {})) {
      if (value == null) continue;
      search.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    const { data } = await this.request<GitlabIssue[]>('GET', `/projects/${gitlabProjectId}/issues?${search.toString()}`);
    return data;
  }
}
