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

export interface FileChange {
  /** Repo-relative path. */
  path: string;
  content: string;
}

/*
 * ПРЕДЛОЖЕНИЕ (worker/IMPLEMENTATION_PLAN.md, этап 1): расширить формат изменений.
 *
 * Текущий `FileChange { path, content }` умеет только текстовый create/update и не может выразить
 * delete / rename / mode / binary — а реальный OpenHands-агент делает `rm`, `mv`, `chmod +x` и
 * правит бинарники. Ниже — размеченный union операций. Формат — operations (а не сырой patch),
 * потому что оба провайдера коммитят через REST API без локального git-checkout, и оба API
 * нативно покрывают весь набор: GitHub Git Data API (delete = `sha: null` в дереве, `mode`,
 * base64-контент) и GitLab commit actions (create/update/delete/move/chmod).
 *
 *   export type FileOp =
 *     | { op: 'upsert'; path: string; content: string; encoding: 'utf-8' | 'base64'; mode?: FileMode }
 *     | { op: 'delete'; path: string }
 *     | { op: 'rename'; from: string; to: string; content?: string; encoding?: 'utf-8' | 'base64'; mode?: FileMode };
 *
 *   // Права/тип entry в git-дереве. GitHub принимает эти же значения в поле `mode`.
 *   export type FileMode = '100644' | '100755' | '120000'; // обычный | исполняемый | симлинк
 *
 * Семантика для merge между стадиями (AgentPipelineService.changesByPath):
 * - upsert по существующему пути перезаписывает; delete по несозданному пути — no-op;
 * - delete после upsert по тому же пути схлопывается в delete;
 * - rename = delete(from) + upsert(to); при коллизии путей между стадиями порядок операций важен,
 *   поэтому merge должен хранить последовательность, а не только «последний по пути».
 *
 * ОБЯЗАТЕЛЬНО: рядом с operations всегда сохраняем сырой git-patch как артефакт — точную копию
 * того, что сделал агент. Он не участвует в применении (коммит собирают провайдеры из операций),
 * но нужен для аудита, диагностики и как fallback-источник истины при расхождении.
 *
 *   export interface StageChangeSet {
 *     ops: FileOp[];
 *     patch: string;      // git diff рабочего дерева относительно baseRef (обязателен)
 *     baseRef: string;    // SHA, относительно которого построены ops и patch
 *   }
 *
 * Затрагивает: этот тип, GitHubProvider.commitChanges, GitLabProvider.commitChanges,
 * AgentPipelineService (merge), AgentExecutor (тип результата стадии) и Python-контракты worker'а.
 */

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
  changes: FileChange[];
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
  abstract commitChanges(params: CommitChangesParams): Promise<CommitResult>;

  abstract openPullRequest(params: OpenPullRequestParams): Promise<PullRequestResult>;
}
