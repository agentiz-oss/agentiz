import type { CommentResult, NormalizedExternalComment, NormalizedExternalTask } from '../git/GitProvider';

export type { NormalizedExternalTask, NormalizedExternalComment, CommentResult };

/**
 * Credentials for a remote task manager. Deliberately a superset of a plain token: Jira wants
 * email + API token, Redmine wants an API key, YouTrack wants a bearer. A concrete adapter reads
 * only the fields it needs and ignores the rest.
 */
export interface TaskManagerCredentials {
  token?: string;
  username?: string;
  password?: string;
  /** How the token is presented; adapters default to whatever their platform expects. */
  authScheme?: 'token' | 'bearer' | 'basic';
  [key: string]: unknown;
}

/**
 * Where inside the remote system the tasks live. Every platform names this differently
 * (repository, project key, board, tracker id), so the shape is intentionally loose and each
 * adapter declares what it needs via `configFields`.
 */
export interface TaskManagerConfig {
  /** API root for self-hosted installations. */
  baseUrl?: string;
  [key: string]: unknown;
}

export interface ListTaskManagerTasksParams {
  /** Only return tasks touched after this instant. */
  updatedSince?: Date;
  /** Raw passthrough filter — shape is adapter-specific. */
  query?: Record<string, unknown>;
}

/** One field an adapter needs from the operator to be configurable from the admin UI. */
export interface TaskManagerConfigField {
  key: string;
  title: string;
  /** `secret` values are stored in AgentTaskSource.secrets and never returned to the UI. */
  kind: 'text' | 'secret';
  required?: boolean;
  placeholder?: string;
  hint?: string;
}

/**
 * Abstract connector to a remote task/project management system.
 *
 * This is the task-tracker half of what GitProvider used to conflate. A project may pull tasks
 * from Jira while committing to GitLab, so "where the tasks come from" and "where the code lives"
 * are separate abstractions with separate collections (`taskManagers` and `gitProviders`).
 *
 * Callers (TaskSourceSyncService) only ever see the methods below and the normalized
 * NormalizedExternalTask shape, regardless of which platform a source is wired to.
 */
export abstract class TaskManagerProvider {
  constructor(
    public readonly type: string,
    protected readonly config: TaskManagerConfig,
    protected readonly credentials: TaskManagerCredentials,
  ) {}

  /** Cheap credential/reachability check behind the UI's "test connection" button. */
  abstract testConnection(): Promise<boolean>;

  /** Tasks to mirror into AgentTask. */
  abstract listTasks(params: ListTaskManagerTasksParams): Promise<NormalizedExternalTask[]>;

  abstract getTask(externalId: string): Promise<NormalizedExternalTask>;

  /**
   * Push our lifecycle back upstream. Optional: a read-only source (an exported CSV, a system we
   * only have read credentials for) simply does not implement it.
   */
  async updateTaskStatus(_externalId: string, _status: string): Promise<void> {
    throw new Error(`Task manager "${this.type}" does not support writing task status back`);
  }

  /** Post a comment upstream. Optional for the same reason as updateTaskStatus. */
  async commentOnTask(_externalId: string, _body: string): Promise<CommentResult> {
    throw new Error(`Task manager "${this.type}" does not support commenting`);
  }

  /**
   * Read the task's discussion upstream, so it can be mirrored into the local thread.
   *
   * Throws rather than returning `[]` when unsupported: an empty thread and an unreadable one are
   * different facts, and a caller that cannot tell them apart would show "комментариев нет" for a
   * lively discussion it simply has no access to.
   */
  async listComments(_externalId: string): Promise<NormalizedExternalComment[]> {
    throw new Error(`Task manager "${this.type}" does not support reading comments`);
  }
}

/**
 * Everything app-agentiz needs to know about one remote task manager: the `type` a source row
 * refers to, how to describe it in the UI, and how to build a provider.
 *
 * Adapters are never hardcoded in the core. Each platform lives in an application layer and is
 * contributed through the app-manager collection `taskManagers` (see TaskManagerCollection.ts),
 * so adding Jira or YouTrack means adding a layer, not editing app-agentiz.
 */
export interface TaskManagerAdapter {
  type: string;
  /** Human-readable name shown in the admin UI and on each task's source badge. */
  title: string;
  /** Short line explaining what this adapter reads. */
  description?: string;
  /** Fields the admin UI renders when configuring a source of this type. */
  configFields?: TaskManagerConfigField[];
  /** True when the adapter can write status/comments back upstream. */
  supportsWriteback?: boolean;
  /**
   * True when `listComments()` is implemented. Declared rather than probed: the UI has to decide
   * whether to offer "подтянуть обсуждение" before any request is made.
   */
  supportsComments?: boolean;
  create(config: TaskManagerConfig, credentials: TaskManagerCredentials): TaskManagerProvider;
}
