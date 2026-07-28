/**
 * Shared domain types for app-agentiz.
 *
 * Naming note: models are prefixed `Agent*` (AgentTask, AgentRun, ...) even though this app
 * lives in its own namespace so its model names remain unique process-wide.
 */

export type GitProviderType = 'github' | 'gitlab';

/** Internal lifecycle of a synced tracker task, independent from the tracker's own status field. */
export type AgentTaskStatus =
  | 'new'
  | 'queued'
  | 'running'
  | 'waiting_review'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'ignored';

export type AgentRunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type AgentRunTrigger = 'sync' | 'manual' | 'webhook' | 'schedule';

export type AgentStageStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export type AgentRunLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type AgentRunJobStatus =
  | 'queued'
  | 'leased'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'released'
  | 'dead';

/**
 * Lifecycle of a worker identity. A worker is useless until an admin approves it: `pending` and
 * `disabled` workers authenticate successfully but receive no jobs, `revoked` ones fail auth.
 */
export type AgentWorkerStatus = 'pending' | 'active' | 'disabled' | 'revoked';

/** `local` is the in-process queue drainer, `external` is a self-enrolled remote worker. */
export type AgentWorkerKind = 'local' | 'external';

export interface AgentWorkerCapabilities {
  /** Executor kinds the worker can run, e.g. ["openhands"]. Informational for now. */
  executors?: string[];
  /** How many jobs the worker is willing to run in parallel. Informational for now. */
  maxConcurrency?: number;
  [key: string]: unknown;
}

/** What happens to the run when a stage fails. */
export type StageFailurePolicy = 'stop' | 'continue';

export interface PipelineStageDef {
  order: number;
  /** Free-form role name used for display/log grouping, e.g. "investigate" | "decide" | "fix" | "commit". */
  role: string;
  /** Key of the AgentRole (scoped to the same project) that provides prompt/model/tools for this stage. */
  agentRoleKey: string;
  onFail: StageFailurePolicy;
}

export type PipelineFinalActionType = 'commit_and_pr' | 'comment_only' | 'none';

export interface PipelineFinalActionDef {
  type: PipelineFinalActionType;
  branchPrefix?: string;
  commitMessageTemplate?: string;
  pullRequestTitleTemplate?: string;
}

/**
 * The "сложный джейсон" rule specification described by the user: which agent roles run, in what
 * order, what happens on failure, and what the pipeline does once all stages succeed.
 * Tag matching itself is NOT part of this JSON - it lives in PipelineSpec.matchTags/isDefault so
 * it stays queryable and editable without touching the pipeline shape.
 * Validated against schemas/pipeline-spec.schema.json (see PipelineSpecResolver).
 */
export interface PipelineSpecDef {
  stages: PipelineStageDef[];
  finalAction: PipelineFinalActionDef;
}

export interface AgentProjectRepoConfig {
  owner: string;
  repo: string;
  /** Override for self-hosted GitLab/GitHub Enterprise. Defaults to the public API host. */
  baseUrl?: string;
  defaultBranch?: string;
}

export interface AgentProjectTrackerConfig {
  /** Poll interval for GitSyncService; absent/0 = sync only on manual trigger. */
  pollIntervalSec?: number;
  /** Raw filter passed through to GitProvider.listTasks (labels, state, ...). */
  query?: Record<string, unknown>;
}

export interface AgentProjectSecrets {
  token?: string;
}
