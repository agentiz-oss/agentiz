/**
 * The environment a pipeline hook script sees.
 *
 * This file is the single definition of that contract, and three consumers read it:
 *
 *   - `AgentPipelineService.buildSnapshot` computes the values and ships them in the job snapshot;
 *   - the worker applies them verbatim (`worker/src/agentiz_worker/hooks.py`), so Python never has
 *     to know how a value is derived — only how to export it;
 *   - the admin editor turns `HOOK_VARIABLES` into autocompletion and into the "unknown variable"
 *     lint, so the names offered while typing are the names that will actually exist.
 *
 * Keeping the catalogue here is what stops those three from drifting: in the project this design
 * was borrowed from, the template grammar lived in three places and had to be kept in step by hand.
 *
 * Values are passed as real environment variables rather than substituted into the script text.
 * Task titles, tags and branch names come from an external tracker and are attacker-controlled in
 * any project that syncs issues; text substitution would turn `"; rm -rf ~` in a title into a
 * command, while an environment variable is opaque to the shell parser.
 */
import type { AgentProject } from '../models/AgentProject';
import type { AgentRun } from '../models/AgentRun';
import type { AgentTask } from '../models/AgentTask';

/** Prefix every hook variable carries. Anything else in the environment came from the machine. */
export const HOOK_ENV_PREFIX = 'AGENTIZ_';

/** Default wall-clock limit for one hook. Deliberately short: a hook is setup, not the work. */
export const DEFAULT_HOOK_TIMEOUT_SEC = 600;

/** Upper bound accepted by validation, and the ceiling the worker enforces. */
export const MAX_HOOK_TIMEOUT_SEC = 3600;

/**
 * Largest script the editor will save. Big enough for real setup work, small enough that a spec
 * stays a spec — a hook that needs more than this belongs in a file in the repository.
 */
export const MAX_HOOK_SCRIPT_BYTES = 64 * 1024;

/**
 * When a variable exists.
 *
 * The editor uses this to explain absence instead of silently offering a name that will be empty:
 * a repository pipeline has no `AGENTIZ_WORKSPACE_PATH`, and a directory pipeline has no commit.
 */
export type HookVariableScope = 'always' | 'repository' | 'workspace' | 'after';

export interface HookVariableDef {
  name: string;
  scope: HookVariableScope;
  /** Shown in the editor's variable palette and in the autocompletion detail line. */
  description: string;
  /** Illustrative value for the palette; never a real one. */
  example: string;
}

export const HOOK_VARIABLES: HookVariableDef[] = [
  { name: 'AGENTIZ_HOOK', scope: 'always', description: 'Which hook is running: before or after', example: 'before' },
  { name: 'AGENTIZ_WORKDIR', scope: 'always', description: 'Directory the script runs in — the same one the agent works in', example: '/srv/projects/monorepo' },
  { name: 'AGENTIZ_RUN_ID', scope: 'always', description: 'AgentRun.id of this run', example: '8f3c…' },
  { name: 'AGENTIZ_JOB_ID', scope: 'always', description: 'AgentRunJob.id the worker is executing', example: '2b91…' },
  { name: 'AGENTIZ_PROJECT_ID', scope: 'always', description: 'AgentProject.id', example: '41ad…' },
  { name: 'AGENTIZ_PROJECT_SLUG', scope: 'always', description: 'Project slug', example: 'backend' },
  { name: 'AGENTIZ_PIPELINE_SOURCE', scope: 'always', description: 'repository or worker_workspace', example: 'repository' },
  { name: 'AGENTIZ_STAGE_COUNT', scope: 'always', description: 'How many stages this run has', example: '3' },
  { name: 'AGENTIZ_TASK_ID', scope: 'always', description: 'AgentTask.id', example: '7c02…' },
  { name: 'AGENTIZ_TASK_EXTERNAL_ID', scope: 'always', description: 'Id in the tracker the task came from', example: 'gl-1001-5' },
  { name: 'AGENTIZ_TASK_TITLE', scope: 'always', description: 'Task title, verbatim — quote it when you print it', example: 'Fix login' },
  { name: 'AGENTIZ_TASK_TAGS', scope: 'always', description: 'Task tags, comma separated', example: 'bug,urgent' },
  { name: 'AGENTIZ_TASK_URL', scope: 'always', description: 'Link to the task in its tracker, empty when it has none', example: 'https://gitlab.com/…/issues/5' },
  { name: 'AGENTIZ_TASK_BRANCH', scope: 'always', description: 'Branch requested by the task itself, empty when it requested none', example: 'feature/login' },

  { name: 'AGENTIZ_REPO_PROVIDER', scope: 'repository', description: 'github or gitlab', example: 'gitlab' },
  { name: 'AGENTIZ_REPO_OWNER', scope: 'repository', description: 'Owner or namespace of the repository', example: 'group/sub' },
  { name: 'AGENTIZ_REPO_NAME', scope: 'repository', description: 'Repository name', example: 'backend' },
  { name: 'AGENTIZ_REPO_SLUG', scope: 'repository', description: 'owner/name together', example: 'group/sub/backend' },
  { name: 'AGENTIZ_BASE_REF', scope: 'repository', description: 'Branch the run took its code from', example: 'develop' },
  { name: 'AGENTIZ_BASE_SHA', scope: 'repository', description: 'Commit the checkout is pinned to', example: 'a1b2c3…' },

  { name: 'AGENTIZ_WORKSPACE_KEY', scope: 'workspace', description: 'Key of the worker directory this pipeline runs in', example: 'monorepo' },
  { name: 'AGENTIZ_WORKSPACE_PATH', scope: 'workspace', description: 'Declared path of that directory', example: '/srv/projects/monorepo' },

  { name: 'AGENTIZ_RUN_STATUS', scope: 'after', description: 'succeeded or failed — the after hook also runs when a stage failed', example: 'succeeded' },
];

/** Lookup used by the editor's linter and by tests that assert the catalogue stayed in sync. */
export const HOOK_VARIABLE_NAMES: ReadonlySet<string> = new Set(HOOK_VARIABLES.map((item) => item.name));

/**
 * Variables the worker fills in, not the server.
 *
 * `AGENTIZ_HOOK` and `AGENTIZ_RUN_STATUS` differ between the two hooks of the same job, and
 * `AGENTIZ_WORKDIR` is only known once the checkout exists. They are still listed above so the
 * editor offers them; they are simply absent from `buildHookEnv`'s output.
 */
export const WORKER_PROVIDED_VARIABLES: ReadonlySet<string> = new Set([
  'AGENTIZ_HOOK',
  'AGENTIZ_WORKDIR',
  'AGENTIZ_RUN_STATUS',
  'AGENTIZ_JOB_ID',
]);

export interface HookEnvInputs {
  run: AgentRun;
  task: AgentTask;
  project: AgentProject;
  stageCount: number;
  /** The snapshot's repository block, when the run has one. */
  repository: { provider?: unknown; owner?: unknown; repo?: unknown; baseRef?: unknown; baseSha?: unknown } | null;
  /** The snapshot's workspace block, when the pipeline runs in a worker directory. */
  workspace: { key?: unknown; path?: unknown } | null;
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * The half of the environment the server knows.
 *
 * Everything here is metadata that is already in the job snapshot; no credential is ever added.
 * A hook that needs to reach the git host should be given its own secret by the operator, because
 * the run's clone token is short-lived, repository-scoped and deliberately never leaves
 * `issueSecrets` — putting it here would hand every hook script a write token.
 */
export function buildHookEnv(inputs: HookEnvInputs): Record<string, string> {
  const { run, task, project, repository, workspace } = inputs;
  const env: Record<string, string> = {
    AGENTIZ_RUN_ID: text(run.id),
    AGENTIZ_PROJECT_ID: text(project.id),
    AGENTIZ_PROJECT_SLUG: text(project.slug),
    AGENTIZ_PIPELINE_SOURCE: workspace ? 'worker_workspace' : 'repository',
    AGENTIZ_STAGE_COUNT: String(inputs.stageCount),
    AGENTIZ_TASK_ID: text(task.id),
    AGENTIZ_TASK_EXTERNAL_ID: text(task.externalId),
    AGENTIZ_TASK_TITLE: text(task.title),
    AGENTIZ_TASK_TAGS: (task.tags ?? []).join(','),
    AGENTIZ_TASK_URL: text(task.externalUrl),
    AGENTIZ_TASK_BRANCH: text(task.branchRef),
  };
  if (repository) {
    const owner = text(repository.owner);
    const repo = text(repository.repo);
    Object.assign(env, {
      AGENTIZ_REPO_PROVIDER: text(repository.provider),
      AGENTIZ_REPO_OWNER: owner,
      AGENTIZ_REPO_NAME: repo,
      AGENTIZ_REPO_SLUG: owner && repo ? `${owner}/${repo}` : '',
      AGENTIZ_BASE_REF: text(repository.baseRef),
      AGENTIZ_BASE_SHA: text(repository.baseSha),
    });
  }
  if (workspace) {
    Object.assign(env, {
      AGENTIZ_WORKSPACE_KEY: text(workspace.key),
      AGENTIZ_WORKSPACE_PATH: text(workspace.path),
    });
  }
  return env;
}

/**
 * Names a script refers to that no run will ever define.
 *
 * Only `AGENTIZ_`-prefixed names are reported: `$HOME`, `$PATH` and the operator's own machine
 * variables are legitimate and none of Agentiz's business. Used by the editor's linter, and
 * exported here so the rule cannot drift away from the catalogue it checks against.
 */
export function unknownHookVariables(script: string): Array<{ name: string; from: number; to: number }> {
  const found: Array<{ name: string; from: number; to: number }> = [];
  // `$NAME` and `${NAME}` — the two forms bash and node (via process.env is different, but a
  // node hook still reads these names) actually use.
  const pattern = /\$\{?(AGENTIZ_[A-Z0-9_]*)\}?/g;
  for (let match = pattern.exec(script); match; match = pattern.exec(script)) {
    if (!HOOK_VARIABLE_NAMES.has(match[1])) {
      found.push({ name: match[1], from: match.index, to: match.index + match[0].length });
    }
  }
  return found;
}
