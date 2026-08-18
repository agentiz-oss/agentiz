/**
 * Normalization of "which LLM harness runs this stage" into one stable key.
 *
 * The key is what the capacity subsystem gates on: subscriptions, worker bindings and usage
 * samples are all `harnessKey`-scoped, and the claim query filters jobs by the `harnessKey`
 * column. Everything that needs the key derives it here — a second derivation would eventually
 * disagree with this one, and a job would be gated by a key its subscription never heard of.
 */

/** A stage snapshot's `agent` block, as built by AgentWorkerJobBuilder.buildSnapshot. */
export interface StageAgentRef {
  kind?: string | null;
  config?: { acpCommand?: unknown; [key: string]: unknown } | null;
}

/** Job kinds that never talk to an LLM and therefore are never limit-gated. */
export const NON_LLM_JOB_KINDS = ['workspace_commit_push', 'workspace_reset'] as const;

/** The job runs stages under more than one harness; gated when any of its keys is gated. */
export const MIXED_HARNESS_KEY = 'mixed';

function commandText(command: unknown): string {
  if (!Array.isArray(command)) return '';
  return command.filter((part) => typeof part === 'string').join(' ');
}

/** Last path segment of a package/script reference, cleaned to a key-safe token. */
function sanitizePackageName(text: string): string | null {
  const parts = text.split(/\s+/).filter((part) => part && !part.startsWith('-'));
  // Skip runners (npx/node/python) and take the first thing that looks like the payload.
  const payload = parts.find((part) => !/^(npx|node|npm|yarn|pnpm|python[0-9.]*|uv|uvx)$/.test(part));
  if (!payload) return null;
  const base = payload.split('/').pop() ?? payload;
  const key = base.replace(/@[^@]*$/, '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return key || null;
}

/**
 * The harness key of one stage, or null when the stage spends no LLM tokens (`bash-fixture`).
 *
 * The worker substitutes `codex-acp` with its own patched launcher (`agentiz_worker.codex_acp`,
 * see worker main.py), so both spellings must map to the same key — a gate that opens for one
 * spelling and not the other would be a gate with a hole in it.
 */
export function harnessKeyForStage(agent: StageAgentRef | null | undefined): string | null {
  if (!agent) return null;
  if (agent.kind === 'bash-fixture') return null;
  const command = commandText(agent.config?.acpCommand);
  if (command.includes('claude-agent-acp')) return 'claude';
  if (command.includes('codex-acp') || command.includes('agentiz_worker.codex_acp')) return 'codex';
  if (command) return sanitizePackageName(command);
  return null;
}

/**
 * Distinct harness keys of a whole job, for `snapshot.harnessKeys` and the `harnessKey` column:
 * one key → itself, several → the column holds MIXED_HARNESS_KEY and the snapshot the full list,
 * none → null (the job is not limit-gated at all).
 */
export function harnessKeysForStages(agents: Array<StageAgentRef | null | undefined>): string[] {
  const keys = new Set<string>();
  for (const agent of agents) {
    const key = harnessKeyForStage(agent);
    if (key) keys.add(key);
  }
  return [...keys];
}

export function harnessColumnValue(keys: string[]): string | null {
  if (keys.length === 0) return null;
  if (keys.length === 1) return keys[0];
  return MIXED_HARNESS_KEY;
}
