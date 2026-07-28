import { GitProvider } from './GitProvider';
import type {
  CommitChangesParams,
  CommitResult,
  ListTasksParams,
  NormalizedExternalTask,
  OpenPullRequestParams,
  PullRequestResult,
} from './GitProvider';

const DEFAULT_API_BASE = 'https://api.github.com';

interface GitHubIssue {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: string;
  labels: Array<{ name: string } | string>;
  pull_request?: unknown;
}

/**
 * GitHub implementation of the abstract GitProvider, using the plain REST v3 API via fetch
 * (no @octokit dependency). Issue read/write endpoints are simple GET/PATCH/POST calls;
 * commitChanges uses the lower-level Git Data API (blobs -> tree -> commit -> ref update) so a
 * single call can push an arbitrary set of file changes as one commit.
 */
export class GitHubProvider extends GitProvider {
  private get apiBase(): string {
    return this.repo.baseUrl?.replace(/\/$/, '') || DEFAULT_API_BASE;
  }

  private get htmlBase(): string {
    // api.github.com -> github.com; GHE api base already points at the right host.
    if (!this.repo.baseUrl) return 'https://github.com';
    return this.repo.baseUrl.replace(/\/api\/v3$/, '').replace(/\/$/, '');
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.credentials.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub API ${method} ${path} failed: ${res.status} ${text.slice(0, 500)}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  private normalizeIssue(issue: GitHubIssue): NormalizedExternalTask {
    return {
      externalId: String(issue.number),
      externalUrl: issue.html_url,
      title: issue.title,
      description: issue.body ?? '',
      tags: issue.labels.map((l) => (typeof l === 'string' ? l : l.name)),
      externalStatus: issue.state,
      raw: issue,
    };
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.request('GET', '/user');
      return true;
    } catch {
      return false;
    }
  }

  async listTasks(params: ListTasksParams): Promise<NormalizedExternalTask[]> {
    const search = new URLSearchParams({ state: 'all', per_page: '100' });
    if (params.updatedSince) search.set('since', params.updatedSince.toISOString());
    if (params.query) {
      for (const [key, value] of Object.entries(params.query)) {
        if (value != null) search.set(key, String(value));
      }
    }
    const issues = await this.request<GitHubIssue[]>(
      'GET',
      `/repos/${this.repo.owner}/${this.repo.repo}/issues?${search.toString()}`,
    );
    // The issues endpoint also returns pull requests; those are not tracker tasks.
    return issues.filter((issue) => !issue.pull_request).map((issue) => this.normalizeIssue(issue));
  }

  async getTask(externalId: string): Promise<NormalizedExternalTask> {
    const issue = await this.request<GitHubIssue>(
      'GET',
      `/repos/${this.repo.owner}/${this.repo.repo}/issues/${externalId}`,
    );
    return this.normalizeIssue(issue);
  }

  async updateTaskStatus(externalId: string, status: string): Promise<void> {
    const closedStatuses = new Set(['done', 'cancelled', 'ignored']);
    await this.request('PATCH', `/repos/${this.repo.owner}/${this.repo.repo}/issues/${externalId}`, {
      state: closedStatuses.has(status) ? 'closed' : 'open',
    });
  }

  async commentOnTask(externalId: string, body: string): Promise<{ url: string }> {
    const comment = await this.request<{ html_url: string }>(
      'POST',
      `/repos/${this.repo.owner}/${this.repo.repo}/issues/${externalId}/comments`,
      { body },
    );
    return { url: comment.html_url };
  }

  async commitChanges(params: CommitChangesParams): Promise<CommitResult> {
    const { owner, repo } = this.repo;
    const baseBranch = params.baseBranch || this.repo.defaultBranch || 'main';

    const baseRef = await this.request<{ object: { sha: string } }>(
      'GET',
      `/repos/${owner}/${repo}/git/ref/heads/${baseBranch}`,
    );
    const baseCommitSha = baseRef.object.sha;

    let branchHeadSha = baseCommitSha;
    try {
      const branchRef = await this.request<{ object: { sha: string } }>(
        'GET',
        `/repos/${owner}/${repo}/git/ref/heads/${params.branch}`,
      );
      branchHeadSha = branchRef.object.sha;
    } catch {
      await this.request('POST', `/repos/${owner}/${repo}/git/refs`, {
        ref: `refs/heads/${params.branch}`,
        sha: baseCommitSha,
      });
    }

    const baseCommit = await this.request<{ tree: { sha: string } }>(
      'GET',
      `/repos/${owner}/${repo}/git/commits/${branchHeadSha}`,
    );

    const treeEntries = [];
    for (const change of params.changes) {
      const blob = await this.request<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/blobs`, {
        content: change.content,
        encoding: 'utf-8',
      });
      treeEntries.push({ path: change.path, mode: '100644', type: 'blob', sha: blob.sha });
    }

    const tree = await this.request<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/trees`, {
      base_tree: baseCommit.tree.sha,
      tree: treeEntries,
    });

    const commit = await this.request<{ sha: string; html_url: string }>(
      'POST',
      `/repos/${owner}/${repo}/git/commits`,
      { message: params.message, tree: tree.sha, parents: [branchHeadSha] },
    );

    await this.request('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${params.branch}`, {
      sha: commit.sha,
      force: true,
    });

    return { sha: commit.sha, url: `${this.htmlBase}/${owner}/${repo}/commit/${commit.sha}` };
  }

  async openPullRequest(params: OpenPullRequestParams): Promise<PullRequestResult> {
    const pr = await this.request<{ html_url: string; number: number }>(
      'POST',
      `/repos/${this.repo.owner}/${this.repo.repo}/pulls`,
      {
        title: params.title,
        body: params.body,
        head: params.branch,
        base: params.baseBranch || this.repo.defaultBranch || 'main',
      },
    );
    return { url: pr.html_url, number: pr.number };
  }
}
