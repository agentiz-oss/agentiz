/**
 * What a person can pick for one manual launch: which runner (harness), which model, how hard it
 * thinks. The catalogue is **advisory UI vocabulary**, not enforcement — a launch may still name a
 * model that is not listed here, because the ACP server, not this file, decides what it accepts,
 * and a new model id must not need a server release to be usable.
 *
 * It is keyed by the same normalized harness key `lib/harness.ts` derives from a stage's
 * `acpCommand`, so the runner a person sees named in the dialog is the one the capacity subsystem
 * gates that run under.
 */
import type { AgentReasoningLevel, AgentRunExecutorOverride } from '../types/agentiz';
import { harnessKeyForStage } from './harness';

export const REASONING_LEVELS: AgentReasoningLevel[] = ['low', 'medium', 'high', 'xhigh'];

export interface HarnessModelOption {
  id: string;
  title: string;
}

export interface HarnessProfile {
  key: string;
  title: string;
  /** Suggested model ids for the picker. Free-form entry stays legal — see the file comment. */
  models: HarnessModelOption[];
  /** Empty = this runner has no thinking-effort control, so the UI must not offer one. */
  reasoningLevels: AgentReasoningLevel[];
}

const PROFILES: Record<string, HarnessProfile> = {
  claude: {
    key: 'claude',
    title: 'Claude Code',
    models: [
      { id: 'opus', title: 'Opus' },
      { id: 'opus[1m]', title: 'Opus (1M контекста)' },
      { id: 'sonnet', title: 'Sonnet' },
      { id: 'haiku', title: 'Haiku' },
    ],
    reasoningLevels: REASONING_LEVELS,
  },
  codex: {
    key: 'codex',
    title: 'Codex',
    models: [
      { id: 'gpt-5.6', title: 'GPT-5.6' },
      { id: 'gpt-5.5', title: 'GPT-5.5' },
      { id: 'gpt-5.4', title: 'GPT-5.4' },
      { id: 'gpt-5.4-mini', title: 'GPT-5.4 Mini' },
    ],
    reasoningLevels: REASONING_LEVELS,
  },
};

/** Russian labels for the levels — the phone UI is the only reader that renders them. */
export const REASONING_LEVEL_TITLES: Record<AgentReasoningLevel, string> = {
  low: 'Быстро',
  medium: 'Обычно',
  high: 'Глубоко',
  xhigh: 'Максимально',
};

/**
 * The profile of a known harness, or a bare one carrying just the key: an unknown runner is still
 * selectable, it simply comes with no suggestions of its own.
 */
export function harnessProfile(key: string | null | undefined): HarnessProfile | null {
  if (!key) return null;
  return PROFILES[key] ?? { key, title: key, models: [], reasoningLevels: [] };
}

/** The harness a configured ACP command belongs to, by the one derivation in `lib/harness.ts`. */
export function harnessKeyForCommand(acpCommand: unknown): string | null {
  return harnessKeyForStage({ config: { acpCommand } });
}

export function isReasoningLevel(value: unknown): value is AgentReasoningLevel {
  return typeof value === 'string' && (REASONING_LEVELS as string[]).includes(value);
}

/** Longest model id worth accepting; a launch dialog is not a place to store a prompt. */
const MAX_MODEL_LENGTH = 200;

export class RunOverrideError extends Error {}

/**
 * Turns a request body into an override, or null when nothing was chosen.
 *
 * Every entry point that starts a run by hand (panel, mobile, MCP) goes through this: the shape is
 * stored on the run and read again by the snapshot builder, so a value that was never checked here
 * would surface as a worker-side failure minutes later.
 */
export function normalizeRunOverride(input: {
  workerId?: unknown;
  executorKey?: unknown;
  model?: unknown;
  reasoningLevel?: unknown;
} | null | undefined): AgentRunExecutorOverride | null {
  if (!input) return null;
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const workerId = text(input.workerId);
  const executorKey = text(input.executorKey);
  const model = text(input.model);
  const reasoningLevel = text(input.reasoningLevel);

  if ((workerId && !executorKey) || (!workerId && executorKey)) {
    throw new RunOverrideError('workerId and executorKey must be provided together');
  }
  if (model.length > MAX_MODEL_LENGTH) {
    throw new RunOverrideError(`model must be at most ${MAX_MODEL_LENGTH} characters`);
  }
  if (reasoningLevel && !isReasoningLevel(reasoningLevel)) {
    throw new RunOverrideError(`reasoningLevel must be one of ${REASONING_LEVELS.join(', ')}`);
  }

  const override: AgentRunExecutorOverride = {};
  if (workerId) {
    override.workerId = workerId;
    override.executorKey = executorKey;
  }
  if (model) override.model = model;
  if (reasoningLevel) override.reasoningLevel = reasoningLevel as AgentReasoningLevel;
  return Object.keys(override).length ? override : null;
}

/**
 * The parenthesised tail of the "Запущен пайплайн" comment: what the person chose, or nothing at
 * all when they took the pipeline as it is. Shared so the panel and the app write the same line.
 */
export function describeRunOverride(override: AgentRunExecutorOverride | null): string {
  if (!override) return '';
  const parts = [
    override.executorKey,
    override.model,
    override.reasoningLevel ? REASONING_LEVEL_TITLES[override.reasoningLevel].toLowerCase() : null,
  ].filter((part): part is string => !!part);
  return parts.length ? ` (${parts.join(', ')})` : '';
}
