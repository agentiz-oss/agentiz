import { normalizeBaseUrl } from './GithubOAuthClient';

/** Minimal GitHub REST v3 client authenticated with an OAuth access token (Bearer). */

export interface GithubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

export interface GithubRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  clone_url: string;
  description: string | null;
  default_branch: string | null;
  private: boolean;
  has_issues?: boolean;
  pushed_at?: string | null;
  owner?: { login: string } | null;
}

export interface GithubIssue {
  id: number;
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: string;
  labels: Array<{ name: string } | string>;
  updated_at: string;
  /** Present on pull requests; GitHub serves them from the same issues endpoint. */
  pull_request?: unknown;
}

export class GithubApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'GithubApiError';
  }
}

export class GithubApiClient {
  private readonly apiBase: string;

  /** `apiBaseUrl` is an API root (`https://api.github.com` or `<ghe>/api/v3`), not a site root. */
  constructor(apiBaseUrl: string, private readonly accessToken: string) {
    this.apiBase = normalizeBaseUrl(apiBaseUrl);
  }

  private async request<T>(method: string, path: string): Promise<{ data: T; link: string | null }> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GithubApiError(`GitHub API ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`, res.status);
    }
    const data = res.status === 204 ? (undefined as T) : ((await res.json()) as T);
    return { data, link: res.headers.get('link') };
  }

  async getCurrentUser(): Promise<GithubUser> {
    return (await this.request<GithubUser>('GET', '/user')).data;
  }

  /**
   * Every repository the token can reach. Pagination is by the `Link` header rather than a page
   * count: GitHub stops sending `rel="next"` on the last page, and a fixed ceiling still guards
   * against an account with thousands of repositories.
   */
  async listAccessibleRepos(options: { maxPages?: number } = {}): Promise<GithubRepo[]> {
    const maxPages = options.maxPages ?? 20;
    const repos: GithubRepo[] = [];

    for (let page = 1; page <= maxPages; page += 1) {
      const search = new URLSearchParams({
        affiliation: 'owner,collaborator,organization_member',
        per_page: '100',
        page: String(page),
        sort: 'pushed',
      });
      const { data, link } = await this.request<GithubRepo[]>('GET', `/user/repos?${search.toString()}`);
      repos.push(...data);
      if (data.length === 0 || !link?.includes('rel="next"')) break;
    }

    return repos;
  }

  async listIssues(
    owner: string,
    repo: string,
    params: { updatedAfter?: Date; query?: Record<string, unknown> } = {},
  ): Promise<GithubIssue[]> {
    const search = new URLSearchParams({ per_page: '100', state: 'all' });
    if (params.updatedAfter) search.set('since', params.updatedAfter.toISOString());
    for (const [key, value] of Object.entries(params.query ?? {})) {
      if (value == null) continue;
      search.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    const { data } = await this.request<GithubIssue[]>('GET', `/repos/${owner}/${repo}/issues?${search.toString()}`);
    // The issues endpoint also returns pull requests; a PR is not a task to run a pipeline on.
    return data.filter((issue) => !issue.pull_request);
  }
}
