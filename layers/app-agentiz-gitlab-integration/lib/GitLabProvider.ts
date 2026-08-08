import { GitProvider, normalizeFileChanges } from '../../app-agentiz/lib/git';
import { parseTaskExternalId } from '../types/gitlab';
import type {
  CommentResult,
  CommitChangesParams,
  CommitResult,
  GitProviderAdapter,
  ListTasksParams,
  NormalizedExternalComment,
  NormalizedExternalTask,
  OpenPullRequestParams,
  PullRequestResult,
  ResolvedRef,
} from '../../app-agentiz/lib/git';

const DEFAULT_API_BASE = 'https://gitlab.com';

/** How many "does this path exist" probes are in flight at once while building a commit. */
const PROBE_CONCURRENCY = 5;

interface GitLabIssue {
  iid: number;
  web_url: string;
  title: string;
  description: string | null;
  state: string;
  labels: string[];
}

interface GitLabNote {
  id: number;
  body: string | null;
  created_at: string | null;
  /** True for activity records ("changed the description"), not real discussion. */
  system: boolean;
  author: { username?: string; name?: string } | null;
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

  /**
   * Tasks that came from a linked repository carry a namespaced external id
   * (`gl-<projectId>-<iid>`), because one Agentiz project aggregates repositories. Everything sent
   * to GitLab has to use the bare iid again.
   *
   * Done for every call rather than in a subclass: `parseTaskExternalId` returns null for a plain
   * iid, so this is a superset of the old behaviour and one class less to keep in sync.
   */
  private toIssueIid(externalId: string): string {
    return parseTaskExternalId(externalId)?.issueIid ?? externalId;
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
    const iid = this.toIssueIid(externalId);
    const issue = await this.request<GitLabIssue>('GET', `/projects/${this.projectPath}/issues/${iid}`);
    return this.normalizeIssue(issue);
  }

  async updateTaskStatus(externalId: string, status: string): Promise<void> {
    const closedStatuses = new Set(['done', 'cancelled', 'ignored']);
    await this.request('PUT', `/projects/${this.projectPath}/issues/${this.toIssueIid(externalId)}`, {
      state_event: closedStatuses.has(status) ? 'close' : 'reopen',
    });
  }

  async commentOnTask(externalId: string, body: string): Promise<CommentResult> {
    const note = await this.request<{ id: number }>(
      'POST',
      `/projects/${this.projectPath}/issues/${this.toIssueIid(externalId)}/notes`,
      { body },
    );
    const issue = await this.getTask(externalId);
    return { id: String(note.id), url: `${issue.externalUrl}#note_${note.id}` };
  }

  async listComments(externalId: string): Promise<NormalizedExternalComment[]> {
    const notes = await this.request<GitLabNote[]>(
      'GET',
      `/projects/${this.projectPath}/issues/${this.toIssueIid(externalId)}/notes?per_page=100&sort=asc&order_by=created_at`,
    );
    // GitLab mixes activity records into the same endpoint ("changed the description",
    // "assigned to @user"). They carry `system: true` and are not discussion — importing them
    // would fill the thread with noise attributed to whoever triggered the change.
    const discussion = notes.filter((note) => !note.system);
    // The issue URL is fetched once, not per note: notes carry no web_url of their own.
    const issueUrl = discussion.length ? (await this.getTask(externalId)).externalUrl : null;
    return discussion.map((note) => ({
      externalId: String(note.id),
      externalUrl: issueUrl ? `${issueUrl}#note_${note.id}` : null,
      authorName: note.author?.username ?? note.author?.name ?? null,
      body: note.body ?? '',
      createdAt: note.created_at ?? null,
      raw: note,
    }));
  }

  async resolveRef(ref: string): Promise<ResolvedRef> {
    // Branch, tag and SHA all resolve through the same endpoint on GitLab too.
    const commit = await this.request<{ id: string }>(
      'GET',
      `/projects/${this.projectPath}/repository/commits/${encodeURIComponent(ref)}`,
    );
    return { ref, sha: commit.id };
  }

  async commitChanges(params: CommitChangesParams): Promise<CommitResult> {
    const baseBranch = params.baseBranch || this.repo.defaultBranch || 'main';

    let branchExists = true;
    try {
      await this.request('GET', `/projects/${this.projectPath}/repository/branches/${encodeURIComponent(params.branch)}`);
    } catch {
      branchExists = false;
    }

    const ops = normalizeFileChanges(params.changes);

    // On an existing branch a "create" action fails when the file is already there, so every
    // upserted path has to be probed. The probes run a few at a time: strictly sequential makes a
    // three-hundred-file diff three hundred round trips end to end, and unbounded opens three
    // hundred connections to one instance at once.
    const probePaths = branchExists
      ? [...new Set(ops.filter((op) => op.op === 'upsert').map((op) => (op as { path: string }).path))]
      : [];
    const existing = new Set<string>();
    for (let index = 0; index < probePaths.length; index += PROBE_CONCURRENCY) {
      const batch = probePaths.slice(index, index + PROBE_CONCURRENCY);
      const found = await Promise.all(batch.map(async (path) => {
        try {
          await this.request(
            'GET',
            `/projects/${this.projectPath}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(params.branch)}`,
          );
          return path;
        } catch {
          // A 404 is the answer, not a failure: the file simply is not there yet.
          return null;
        }
      }));
      for (const path of found) if (path) existing.add(path);
    }

    const actions: Array<Record<string, unknown>> = [];
    for (const op of ops) {
      if (op.op === 'delete') {
        actions.push({ action: 'delete', file_path: op.path });
        continue;
      }
      if (op.op === 'rename') {
        // `move` carries content only when the file also changed; without it GitLab keeps the blob.
        actions.push({
          action: 'move',
          previous_path: op.from,
          file_path: op.to,
          ...(op.content !== undefined ? { content: op.content, encoding: op.encoding ?? 'text' } : {}),
        });
        if (op.mode) actions.push({ action: 'chmod', file_path: op.to, execute_filemode: op.mode === '100755' });
        continue;
      }
      actions.push({
        action: existing.has(op.path) ? 'update' : 'create',
        file_path: op.path,
        content: op.content,
        // GitLab spells the text encoding `text`, not `utf-8`.
        encoding: op.encoding === 'base64' ? 'base64' : 'text',
      });
      if (op.mode) actions.push({ action: 'chmod', file_path: op.path, execute_filemode: op.mode === '100755' });
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
  // Only this layer knows what a GitLab task id looks like; the core asks instead of parsing.
  parseTaskExternalId: (externalId) => {
    const parsed = parseTaskExternalId(externalId);
    return parsed ? { externalRepoId: parsed.gitlabProjectId, issueId: parsed.issueIid } : null;
  },
};
