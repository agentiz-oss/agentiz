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

/** Operator-set urgency, independent of anything the upstream tracker reports. */
export type AgentTaskPriority = 'low' | 'normal' | 'high' | 'urgent';

/** Who wrote a task comment: a person, a pipeline run, or the platform itself. */
export type AgentTaskCommentAuthorKind = 'human' | 'agent' | 'system';

/**
 * Where a comment was written. Orthogonal to `AgentTaskCommentAuthorKind`: a person commenting in
 * GitLab is `human` + `remote`, the same person commenting in Agentiz is `human` + `local`.
 */
export type AgentTaskCommentOrigin = 'local' | 'remote';

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
 * Lifecycle of a worker identity, modelled on GitLab runners: an admin creates the worker in the
 * panel and it is `active` from that moment — there is no approval step, because creating it *is*
 * the authorisation. `paused` workers authenticate but receive no jobs, `revoked` ones have no
 * token left and fail auth.
 */
export type AgentWorkerStatus = 'active' | 'paused' | 'revoked';

/**
 * Connectivity, derived from `lastSeenAt` rather than stored: a worker that was created but has
 * never called the API is `never_contacted`, one that stopped polling goes `offline`.
 */
export type AgentWorkerContactState = 'never_contacted' | 'online' | 'offline';

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

/**
 * Development runner selected by a pipeline stage.  It is deliberately a pipeline property:
 * a role describes an agent, while this decides where OpenHands executes it.
 *
 * This is only the stage-0 spike contract. ACP command and credentials remain owned by the
 * role/worker protocol.
 */
export interface PipelineStageRuntimeDef {
  mode: 'host' | 'docker';
}

export interface PipelineStageDef {
  order: number;
  /** Free-form role name used for display/log grouping, e.g. "investigate" | "decide" | "fix" | "commit". */
  role: string;
  /** Key of the AgentRole (scoped to the same project) that provides prompt/model/tools for this stage. */
  agentRoleKey: string;
  onFail: StageFailurePolicy;
  /** Selects the workspace used by the worker. */
  runtime: PipelineStageRuntimeDef;
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
