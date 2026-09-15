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

/** One head of a branch, as `GET /repos/:o/:r/branches` reports it. */
export interface GithubBranch {
  name: string;
  commit: { sha: string };
  protected?: boolean;
}

export interface GithubCommit {
  sha: string;
  html_url: string;
  commit: { message: string; author?: { name?: string | null; email?: string | null } | null };
  author?: { login?: string | null } | null;
}

/**
 * `GET /repos/:o/:r/compare/:base...:head`.
 *
 * `status: 'diverged'` is how a force-push is recognised: the new head is not a descendant of the
 * old one, so the commits `compare` lists are the ones the branch gained, not the ones it kept.
 */
export interface GithubComparison {
  status: 'diverged' | 'ahead' | 'behind' | 'identical';
  ahead_by: number;
  behind_by: number;
  html_url: string;
  commits: GithubCommit[];
}

/** A finished GitHub Actions run — the `workflow_run` shape, from the REST listing. */
export interface GithubWorkflowRun {
  id: number;
  name: string | null;
  head_branch: string | null;
  head_sha: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  updated_at: string;
}

/** A repository webhook as GitHub reports it. */
export interface GithubHook {
  id: number;
  name: string;
  active: boolean;
  events: string[];
  config: { url?: string; content_type?: string };
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<{ data: T; link: string | null }> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

  /**
   * Every branch head in one page-walked call — the cheap half of watching a repository.
   *
   * Branch heads rather than `/commits?since=`: that endpoint filters by *author* date, which loses
   * a rebase and a force-push entirely, and it only ever reports the default branch. Comparing
   * stored heads to current ones is the only reading that survives history being rewritten.
   */
  async listBranches(owner: string, repo: string, options: { maxPages?: number } = {}): Promise<GithubBranch[]> {
    const maxPages = options.maxPages ?? 10;
    const branches: GithubBranch[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const search = new URLSearchParams({ per_page: '100', page: String(page) });
      const { data, link } = await this.request<GithubBranch[]>('GET', `/repos/${owner}/${repo}/branches?${search}`);
      branches.push(...data);
      if (data.length === 0 || !link?.includes('rel="next"')) break;
    }
    return branches;
  }

  /** What a branch gained between two heads. `base`/`head` may be shas or branch names. */
  async compareCommits(owner: string, repo: string, base: string, head: string): Promise<GithubComparison> {
    const range = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
    return (await this.request<GithubComparison>('GET', `/repos/${owner}/${repo}/compare/${range}`)).data;
  }

  /**
   * Finished Actions runs, newest first.
   *
   * `status=completed` on purpose: a run that has not finished has no conclusion, and the event
   * this feeds is "завершился CI-прогон" — a started build is not something a graph can react to.
   */
  async listWorkflowRuns(owner: string, repo: string, options: { perPage?: number } = {}): Promise<GithubWorkflowRun[]> {
    const search = new URLSearchParams({ status: 'completed', per_page: String(options.perPage ?? 50) });
    const { data } = await this.request<{ workflow_runs?: GithubWorkflowRun[] }>(
      'GET',
      `/repos/${owner}/${repo}/actions/runs?${search}`,
    );
    return data.workflow_runs ?? [];
  }

  // -------------------------------------------------------------------------
  // Repository webhooks. `repo` already covers all four — no extra consent.
  // -------------------------------------------------------------------------

  async listHooks(owner: string, repo: string): Promise<GithubHook[]> {
    return (await this.request<GithubHook[]>('GET', `/repos/${owner}/${repo}/hooks?per_page=100`)).data;
  }

  async createHook(owner: string, repo: string, input: { url: string; secret: string; events: string[] }): Promise<GithubHook> {
    return (await this.request<GithubHook>('POST', `/repos/${owner}/${repo}/hooks`, {
      name: 'web',
      active: true,
      events: input.events,
      config: { url: input.url, content_type: 'json', secret: input.secret, insecure_ssl: '0' },
    })).data;
  }

  /**
   * Change an existing hook's event set, keeping its id, its URL and its secret.
   *
   * The alternative — delete and recreate — rotates the secret, and a delivery in flight during
   * that window arrives with a signature nothing can check.
   */
  async updateHook(owner: string, repo: string, hookId: string, input: { events: string[] }): Promise<GithubHook> {
    return (await this.request<GithubHook>('PATCH', `/repos/${owner}/${repo}/hooks/${hookId}`, {
      active: true,
      events: input.events,
    })).data;
  }

  async deleteHook(owner: string, repo: string, hookId: string): Promise<void> {
    await this.request<void>('DELETE', `/repos/${owner}/${repo}/hooks/${hookId}`);
  }

  /**
   * Ask GitHub to deliver a `ping` right now.
   *
   * This is what turns "хук создан" into "хук доставляется": a server GitHub cannot reach fails
   * here, at install time and in front of the person who linked the repository, instead of at the
   * first real push when nobody is watching.
   */
  async pingHook(owner: string, repo: string, hookId: string): Promise<void> {
    await this.request<void>('POST', `/repos/${owner}/${repo}/hooks/${hookId}/pings`, {});
  }
}
