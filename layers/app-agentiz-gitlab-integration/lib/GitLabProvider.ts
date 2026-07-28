import { GitProvider } from '../../app-agentiz/lib/git';
import type {
  CommitChangesParams,
  CommitResult,
  GitProviderAdapter,
  ListTasksParams,
  NormalizedExternalTask,
  OpenPullRequestParams,
  PullRequestResult,
} from '../../app-agentiz/lib/git';

const DEFAULT_API_BASE = 'https://gitlab.com';

interface GitLabIssue {
  iid: number;
  web_url: string;
  title: string;
  description: string | null;
  state: string;
  labels: string[];
}

/**
 * GitLab implementation of the abstract GitProvider (REST v4).
 *
 * Lives in this layer, not in app-agentiz: the core knows only the abstract GitProvider and gets
 * concrete platforms through the `gitProviders` app-manager collection (see gitlabProviderAdapter
 * at the bottom of this file).
 *
 * Notable shape differences the abstraction hides from callers:
 *  - the project is addressed by a URL-encoded "owner/repo" path, not two separate segments;
 *  - issues are identified by `iid` (per-project number), not a global id;
 *  - a multi-file commit is a single POST to /repository/commits with an `actions` array, so
 *    there is no blob/tree/ref dance like on GitHub;
 *  - pull requests are "merge requests".
 */
export class GitLabProvider extends GitProvider {
  private get apiBase(): string {
    const base = this.repo.baseUrl?.replace(/\/$/, '') || DEFAULT_API_BASE;
    return base.endsWith('/api/v4') ? base : `${base}/api/v4`;
  }

  private get projectPath(): string {
    return encodeURIComponent(`${this.repo.owner}/${this.repo.repo}`);
  }

  /** OAuth access tokens are only accepted as Bearer; personal access tokens use PRIVATE-TOKEN. */
  private get authHeaders(): Record<string, string> {
    return this.credentials.authScheme === 'bearer'
      ? { Authorization: `Bearer ${this.credentials.token}` }
      : { 'PRIVATE-TOKEN': this.credentials.token };
  }

  protected async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        ...this.authHeaders,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitLab API ${method} ${path} failed: ${res.status} ${text.slice(0, 500)}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  private normalizeIssue(issue: GitLabIssue): NormalizedExternalTask {
    return {
      externalId: String(issue.iid),
      externalUrl: issue.web_url,
      title: issue.title,
      description: issue.description ?? '',
      tags: issue.labels ?? [],
      externalStatus: issue.state,
      raw: issue,
    };
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.request('GET', `/projects/${this.projectPath}`);
      return true;
    } catch {
      return false;
    }
  }

  async listTasks(params: ListTasksParams): Promise<NormalizedExternalTask[]> {
    const search = new URLSearchParams({ per_page: '100' });
    if (params.updatedSince) search.set('updated_after', params.updatedSince.toISOString());
    if (params.query) {
      for (const [key, value] of Object.entries(params.query)) {
        if (value != null) search.set(key, String(value));
      }
    }
    const issues = await this.request<GitLabIssue[]>(
      'GET',
      `/projects/${this.projectPath}/issues?${search.toString()}`,
    );
    return issues.map((issue) => this.normalizeIssue(issue));
  }

  async getTask(externalId: string): Promise<NormalizedExternalTask> {
    const issue = await this.request<GitLabIssue>('GET', `/projects/${this.projectPath}/issues/${externalId}`);
    return this.normalizeIssue(issue);
  }

  async updateTaskStatus(externalId: string, status: string): Promise<void> {
    const closedStatuses = new Set(['done', 'cancelled', 'ignored']);
    await this.request('PUT', `/projects/${this.projectPath}/issues/${externalId}`, {
      state_event: closedStatuses.has(status) ? 'close' : 'reopen',
    });
  }

  async commentOnTask(externalId: string, body: string): Promise<{ url: string }> {
    const note = await this.request<{ id: number }>(
      'POST',
      `/projects/${this.projectPath}/issues/${externalId}/notes`,
      { body },
    );
    const issue = await this.getTask(externalId);
    return { url: `${issue.externalUrl}#note_${note.id}` };
  }

  async commitChanges(params: CommitChangesParams): Promise<CommitResult> {
    const baseBranch = params.baseBranch || this.repo.defaultBranch || 'main';

    let branchExists = true;
    try {
      await this.request('GET', `/projects/${this.projectPath}/repository/branches/${encodeURIComponent(params.branch)}`);
    } catch {
      branchExists = false;
    }

    // On an existing branch a "create" action fails if the file is already there, so probe each path.
    const actions = [];
    for (const change of params.changes) {
      let action: 'create' | 'update' = 'create';
      if (branchExists) {
        try {
          await this.request(
            'GET',
            `/projects/${this.projectPath}/repository/files/${encodeURIComponent(change.path)}?ref=${encodeURIComponent(params.branch)}`,
          );
          action = 'update';
        } catch {
          action = 'create';
        }
      }
      actions.push({ action, file_path: change.path, content: change.content });
    }

    const commit = await this.request<{ id: string; web_url: string }>(
      'POST',
      `/projects/${this.projectPath}/repository/commits`,
      {
        branch: params.branch,
        ...(branchExists ? {} : { start_branch: baseBranch }),
        commit_message: params.message,
        actions,
      },
    );

    return { sha: commit.id, url: commit.web_url };
  }

  async openPullRequest(params: OpenPullRequestParams): Promise<PullRequestResult> {
    const mr = await this.request<{ web_url: string; iid: number }>(
      'POST',
      `/projects/${this.projectPath}/merge_requests`,
      {
        source_branch: params.branch,
        target_branch: params.baseBranch || this.repo.defaultBranch || 'main',
        title: params.title,
        description: params.body,
      },
    );
    return { url: mr.web_url, number: mr.iid };
  }
}

/**
 * What this layer contributes to the `gitProviders` collection: as long as the layer is mounted,
 * projects with `repoProvider: 'gitlab'` are served by this class; unmounting it takes GitLab
 * support out of app-agentiz with it.
 */
export const gitlabProviderAdapter: GitProviderAdapter = {
  type: 'gitlab',
  create: (repo, credentials) => new GitLabProvider('gitlab', repo, credentials),
};
