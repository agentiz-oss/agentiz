/**
 * Shared domain types for app-agentiz.
 *
 * Naming note: models are prefixed `Agent*` (AgentTask, AgentRun, ...) even though this app
 * lives in its own namespace so its model names remain unique process-wide.
 */

export type GitProviderType = 'github' | 'gitlab';

/**
 * Lifecycle of one authorized account at a hosting platform. `expired` means the stored token is
 * past its lifetime and could not be refreshed, `revoked` that it was deliberately withdrawn —
 * both need a fresh authorization, but only the second one is somebody's decision.
 */
export type GitConnectionStatus = 'active' | 'expired' | 'revoked' | 'error';

export interface GitConnectionSecrets {
  accessToken?: string;
  refreshToken?: string;
}

/** What a repository linked to a project is used for inside the pipeline. */
export type ProjectRepositoryRole = 'source' | 'target' | 'both';

export interface ProjectRepositoryConfig {
  /** Minimum seconds between task syncs of this link; 0/absent = every scheduled tick. */
  pollIntervalSec?: number;
  /** Raw passthrough filter for the platform's issue listing (state, labels, milestone, ...). */
  query?: Record<string, unknown>;
  /** Branch commits are based on; falls back to the repository's own default branch. */
  defaultBranch?: string;
}

/** Internal lifecycle of a synced tracker task, independent from the tracker's own status field. */
export type AgentTaskStatus =
  | 'new'
  | 'queued'
  | 'running'
  | 'waiting_input'
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

export type AgentRunStatus = 'pending' | 'running' | 'waiting_input' | 'succeeded' | 'failed' | 'cancelled';

export type AgentRunTrigger = 'sync' | 'manual' | 'webhook' | 'schedule' | 'human_comment';

export type AgentStageStatus = 'pending' | 'running' | 'waiting_input' | 'succeeded' | 'failed' | 'skipped';

export type AgentRunInteractionKind = 'elicitation';
export type AgentRunInteractionStatus =
  | 'pending'
  | 'answered'
  | 'delivered'
  | 'cancelled'
  | 'expired'
  | 'orphaned';
export type AgentRunInteractionAction = 'accept' | 'decline' | 'cancel';

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

export type AgentRunJobKind = 'pipeline' | 'workspace_commit_push' | 'workspace_reset';

export type AgentWorkspaceProposalStatus =
  | 'working'
  | 'waiting_review'
  | 'continuing'
  | 'apply_queued'
  | 'applying'
  | 'pushed'
  | 'push_failed'
  | 'reset_queued'
  | 'resetting'
  | 'rejected'
  | 'reset_failed';

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

/** A named, administrator-configured ACP runner available on one worker. */
export interface AgentWorkerExecutor {
  /** Stable identifier used when a person selects this runner for a manual launch. */
  key: string;
  /** Human-readable label, for example "Claude" or "Codex". */
  title?: string;
  /** ACP command owned by the worker administrator, never supplied by a run request. */
  acpCommand: string[];
}

/** An explicit manual choice is also a worker pin: another machine may not have that runner installed. */
export interface AgentRunExecutorOverride {
  workerId: string;
  executorKey: string;
}

/**
 * A prepared directory on the worker's own machine, declared by an admin on the worker record.
 *
 * This is what makes a pipeline able to work "in place" instead of against a hosted repository:
 * the environment (dependencies, .env files, a git checkout somebody maintains by hand) already
 * exists on that host, and the pipeline only names it. `key` is what a pipeline stores, so it must
 * stay stable when the path is corrected.
 */
export interface AgentWorkerWorkspace {
  key: string;
  path: string;
  label?: string;
  description?: string;
  /** Git operations are an explicit operator grant, never implied by merely exposing a path. */
  git?: {
    pushEnabled: boolean;
    remote?: string;
  };
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
  /**
   * Overrides the role's own `model` for this stage only. Absent = the role's model, which is
   * unchanged behaviour for every spec written before this field. Applied to the ACP session after
   * it starts (`acp_model` on the worker's ACPAgent) — the executor picks the concrete model id, so
   * this is free-form text rather than an enum here.
   */
  model?: string;
  onFail: StageFailurePolicy;
  /** Selects the workspace used by the worker. */
  runtime: PipelineStageRuntimeDef;
}

/**
 * `commit` pushes straight onto the target branch without opening anything for review;
 * `commit_and_pr` keeps the agent's work on its own branch and opens a PR/MR from it.
 */
export type PipelineFinalActionType = 'commit_and_pr' | 'commit' | 'comment_only' | 'none';

export interface PipelineFinalActionDef {
  type: PipelineFinalActionType;
  branchPrefix?: string;
  /** Target branch for `commit`. Defaults to the branch the run took its code from. */
  branch?: string;
  commitMessageTemplate?: string;
  pullRequestTitleTemplate?: string;
  /**
   * Hold the change in Agentiz instead of pushing it. The diff is stored either way (see
   * AgentRunDiff); with this on, nothing reaches the repository until somebody applies it.
   */
  requireApproval?: boolean;
  /** Worker-workspace delivery target. Repository-source pipelines keep using branch/branchPrefix. */
  targetBranch?: {
    mode: 'current' | 'new';
    prefix?: string;
  };
}

/**
 * Where the code a run works on comes from.
 *
 * `repository` is the historical behaviour: the project's git provider decides what the run sees.
 * `worker_workspace` skips hosting entirely — the run is pinned to one worker and executes in a
 * directory that already exists on that machine.
 */
export type PipelineSourceKind = 'repository' | 'worker_workspace';

/**
 * Names the directory a `worker_workspace` run works in. Exactly one of `workspaceKey` or `path`
 * is set: `workspaceKey` looks up a directory the worker operator declared in advance
 * (`AgentWorker.workspaces[].key`); `path` is an absolute path given directly by the spec, with no
 * declaration on the worker required.
 */
export interface PipelineWorkerWorkspaceDef {
  workerId: string;
  /** Key of an entry in the worker's declared Workspaces list. Mutually exclusive with `path`. */
  workspaceKey?: string;
  /** Absolute path on the worker's machine, given directly by the spec. Mutually exclusive with `workspaceKey`. */
  path?: string;
  /**
   * Only meaningful with `path`: create the directory if it does not exist instead of failing.
   * Ignored with `workspaceKey` — a declared directory is expected to already exist, so a typo
   * there should surface as an error rather than a silently created empty tree.
   */
  createIfMissing?: boolean;
}

export interface PipelineSourceDef {
  /** Absent means `repository`, so every spec written before this field keeps its meaning. */
  kind?: PipelineSourceKind;
  /** Required when kind is `worker_workspace`, ignored otherwise. */
  workspace?: PipelineWorkerWorkspaceDef;
  /**
   * Which of the project's repositories this pipeline works on (`AgentRepository.id`).
   *
   * Absent = the repository the task itself came from, which is the historical behaviour and the
   * right default for a project whose tasks and code live together. Setting it is for the case
   * where they do not: tasks arrive from one place, the code being changed is somewhere else.
   *
   * Only a repository already linked to the same project is accepted — a pipeline must not be able
   * to reach a repository the project was never given.
   */
  repositoryId?: string;
  /**
   * Default branch for this pipeline. Absent = the repository's own default branch.
   *
   * Only the *default* lives here: a task may carry its own branch (`AgentTask.branchRef` or a
   * `branch:<ref>` tag), which wins unless `allowTaskOverride` is explicitly false — that is for a
   * project which must always build from one branch.
   */
  branch?: string;
  allowTaskOverride?: boolean;
}

/**
 * What runs a hook script. `bash` is the everyday case; `node` is there because a project that
 * already has a JS toolchain should not have to shell out to use it.
 *
 * The value picks the interpreter directly rather than reading a shebang out of the script: the
 * worker writes the script to a temporary file and invokes the interpreter by absolute path, so a
 * script can never select its own interpreter (`#!/usr/bin/env anything`) on the operator's machine.
 */
export type PipelineHookInterpreter = 'bash' | 'node';

/**
 * A script the pipeline runs around its stages, in the same directory the agent works in.
 *
 * Values reach the script as ordinary environment variables (`$AGENTIZ_TASK_TITLE` and friends,
 * see lib/hookEnv.ts), never as text substituted into the source. A task title is attacker-supplied
 * in any project that syncs issues, and pasting it into a shell script would make every such title
 * a command.
 */
export interface PipelineHookDef {
  interpreter: PipelineHookInterpreter;
  /** Source as typed in the editor, without a shebang line — the worker adds one. */
  script: string;
  /** Wall-clock limit. Absent = DEFAULT_HOOK_TIMEOUT_SEC; a hook is not where a run should hang. */
  timeoutSec?: number;
  /** `stop` (default) fails the run on a non-zero exit; `continue` logs it and carries on. */
  onFail?: StageFailurePolicy;
}

/**
 * `before` runs once the working directory is ready and before the first stage — install
 * dependencies, start a database, generate config.
 *
 * `after` runs once the stages are done and **before** the diff is collected, so whatever it
 * writes (a formatter, a codegen step) is part of the change the run proposes. It also runs when a
 * stage failed, with `AGENTIZ_RUN_STATUS=failed`, so it can serve as teardown; its own failure
 * never replaces the original error.
 */
export interface PipelineHooksDef {
  before?: PipelineHookDef;
  after?: PipelineHookDef;
}

/** Events that may create a new run for a task matching this pipeline. */
export interface PipelineTriggersDef {
  /** Start a run after a person adds a message to the task thread. Defaults to false. */
  humanComment?: boolean;
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
  /** Optional, deliberately opt-in automation for this project's pipeline. */
  triggers?: PipelineTriggersDef;
  /** Absent = work against the project's repository, as every pre-existing spec does. */
  source?: PipelineSourceDef;
  /** Scripts run around the stages, in the same directory. Absent = nothing runs, as before. */
  hooks?: PipelineHooksDef;
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
