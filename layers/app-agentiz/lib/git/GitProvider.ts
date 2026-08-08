import type { AgentProjectRepoConfig, GitProviderType } from '../../types/agentiz';

export interface GitCredentials {
  token: string;
  /**
   * How the token is presented to the platform. Personal access tokens use the platform's own
   * header (`PRIVATE-TOKEN` on GitLab), OAuth access tokens must be sent as `Authorization: Bearer`.
   * Defaults to the platform's token header when omitted.
   */
  authScheme?: 'token' | 'bearer';
}

/** Task shape normalized from whatever the concrete platform returns (GitHub issue, GitLab issue, ...). */
export interface NormalizedExternalTask {
  externalId: string;
  externalUrl: string;
  title: string;
  description: string;
  tags: string[];
  externalStatus: string;
  raw: unknown;
}

/** One comment on a tracker task, normalized across platforms. */
export interface NormalizedExternalComment {
  /** Platform's own comment id. This is what dedup keys on, so it must be stable. */
  externalId: string;
  externalUrl: string | null;
  /** Login/display name of whoever wrote it upstream. */
  authorName: string | null;
  body: string;
  /** ISO timestamp from the platform, used to order the thread by when it was really written. */
  createdAt: string | null;
  raw: unknown;
}

/**
 * Result of posting a comment. The `id` matters as much as the url: a comment we pushed comes
 * back on the next pull, and without the platform's own id there is no way to recognise it as
 * ours — every push would duplicate itself in the thread.
 */
export interface CommentResult {
  id: string;
  url: string;
}

/** A ref as it was asked for, plus the commit it pointed at when it was resolved. */
export interface ResolvedRef {
  /** Branch, tag or SHA, exactly as requested. */
  ref: string;
  sha: string;
}

export interface FileChange {
  /** Repo-relative path. */
  path: string;
  content: string;
}

/** Permission/type of an entry in a git tree. GitHub takes these same values in `mode`. */
export type FileMode = '100644' | '100755' | '120000';

/**
 * One change an agent made, in a form both platforms can commit through their REST API without a
 * local git checkout: GitHub's Git Data API (delete = `sha: null` in the tree, `mode`, base64
 * content) and GitLab's commit actions (create/update/delete/move/chmod) cover all of it natively.
 *
 * A plain `FileChange { path, content }` could only express a text create/update, while a real
 * agent runs `rm`, `mv`, `chmod +x` and edits binaries.
 */
export type FileOp =
  | { op: 'upsert'; path: string; content: string; encoding: 'utf-8' | 'base64'; mode?: FileMode }
  | { op: 'delete'; path: string }
  | { op: 'rename'; from: string; to: string; content?: string; encoding?: 'utf-8' | 'base64'; mode?: FileMode };

/**
 * What one stage produced. The raw patch is kept **beside** the operations, always: the commit is
 * assembled from the operations, but the patch is the exact record of what the agent did and the
 * source of truth when the two disagree.
 */
export interface StageChangeSet {
  ops: FileOp[];
  /** `git diff` of the working tree against `baseRef`. */
  patch: string;
  /** SHA the ops and the patch were built against. */
  baseRef: string;
}

/**
 * Merges operations of consecutive stages, keeping their order.
 *
 * Order matters and "last write per path" is not enough: `delete` after `upsert` of the same path
 * collapses into a single `delete`, `delete` of a path this run created is a no-op, and a `rename`
 * is a `delete` plus an `upsert` whose paths may collide with what another stage did.
 */
export function mergeFileOps(previous: FileOp[], next: FileOp[]): FileOp[] {
  const merged = [...previous];

  const dropPath = (path: string) => {
    for (let index = merged.length - 1; index >= 0; index -= 1) {
      const existing = merged[index];
      const owns = existing.op === 'rename' ? existing.to === path : existing.path === path;
      if (owns) merged.splice(index, 1);
    }
  };

  for (const op of next) {
    if (op.op === 'delete') {
      // Everything this run had done to the path is undone by deleting it; only the delete has to
      // reach the repository, and only if the path was not created by this run in the first place.
      let createdHere = false;
      for (const existing of merged) {
        if (existing.op === 'upsert' && existing.path === op.path) createdHere = true;
        if (existing.op === 'rename' && existing.to === op.path) createdHere = true;
      }
      dropPath(op.path);
      if (!createdHere) merged.push(op);
      continue;
    }
    if (op.op === 'rename') {
      dropPath(op.to);
      merged.push(op);
      continue;
    }
    dropPath(op.path);
    merged.push(op);
  }

  return merged;
}

/** Accepts the legacy shape so an older worker and the stub executor keep working. */
export function normalizeFileChanges(changes: Array<FileChange | FileOp> | null | undefined): FileOp[] {
  return (changes ?? []).map((change) => {
    if ('op' in change) return change;
    return { op: 'upsert' as const, path: change.path, content: change.content, encoding: 'utf-8' as const };
  });
}

export interface CommitResult {
  sha: string;
  url: string;
}

export interface PullRequestResult {
  url: string;
  number: number | string;
}

export interface ListTasksParams {
  /** Only return tasks touched after this instant (maps to `since`/`updated_after`). */
  updatedSince?: Date;
  /** Raw passthrough filter (labels, state, ...) - shape is provider-specific. */
  query?: Record<string, unknown>;
}

export interface CommitChangesParams {
  branch: string;
  baseBranch?: string;
  message: string;
  /** Legacy `FileChange[]` is still accepted; normalizeFileChanges turns it into upserts. */
  changes: Array<FileChange | FileOp>;
}

export interface OpenPullRequestParams {
  branch: string;
  baseBranch?: string;
  title: string;
  body?: string;
}

/**
 * Abstract connector to an external Git hosting + issue tracker platform.
 *
 * This is the "жёсткие параметры" abstraction the user asked for: callers (GitSyncService,
 * AgentPipelineService's commit stage) only ever see the methods declared here, using the same
 * normalized shapes (NormalizedExternalTask, FileChange, CommitResult, ...) regardless of which
 * platform a project is wired to. Each concrete subclass (GitHubProvider, GitLabProvider, ...)
 * is responsible for converting those rigid parameters into whatever its own REST API expects.
 */
export abstract class GitProvider {
  constructor(
    public readonly type: GitProviderType,
    protected readonly repo: AgentProjectRepoConfig,
    protected readonly credentials: GitCredentials,
  ) {}

  /** Cheap credential/reachability check, used by the Adminizer UI's "test connection" action. */
  abstract testConnection(): Promise<boolean>;

  /** List tracker issues/tasks to mirror into AgentTask (see GitSyncService). */
  abstract listTasks(params: ListTasksParams): Promise<NormalizedExternalTask[]>;

  abstract getTask(externalId: string): Promise<NormalizedExternalTask>;

  /** Best-effort mapping of our internal AgentTaskStatus onto whatever states the platform has. */
  abstract updateTaskStatus(externalId: string, status: string): Promise<void>;

  abstract commentOnTask(externalId: string, body: string): Promise<CommentResult>;

  /**
   * Reads the task's discussion upstream.
   *
   * Concrete rather than abstract so a provider written before comments existed keeps compiling
   * and fails with a clear message instead of silently returning an empty thread — "no comments"
   * and "cannot read comments" must not look the same to the caller.
   */
  async listComments(_externalId: string): Promise<NormalizedExternalComment[]> {
    throw new Error(`Provider "${this.type}" cannot read task comments`);
  }

  /** Creates (or reuses) `branch` and commits `changes` onto it in a single atomic operation. */
  /**
   * Turns a branch name into the commit it currently points at.
   *
   * The worker is given a SHA rather than a branch name because a branch moves: between queueing a
   * job and a worker claiming it — or between the first attempt and a retry — somebody pushes, and
   * two attempts at the same job must still see the same code.
   *
   * Tags and raw SHAs are accepted too, so `source.branch: "v1.2.0"` works.
   */
  abstract resolveRef(ref: string): Promise<ResolvedRef>;

  abstract commitChanges(params: CommitChangesParams): Promise<CommitResult>;

  abstract openPullRequest(params: OpenPullRequestParams): Promise<PullRequestResult>;
}
