import type { AgentRun } from '../models/AgentRun';

/**
 * Token spend for one run as every read surface serializes it (dashboard, MCP, mobile), or null
 * when nothing was ever reported (old runs, executors without usage) so a UI draws no badge
 * instead of a zero. BIGINT arrives as a string from postgres, hence the Number() on every field.
 * Accumulated across attempts — the per-stage `AgentStageExecution.output.usage` keeps only the
 * last one.
 */
export function runUsage(run: AgentRun) {
  if (run.usageTotalTokens == null) return null;
  return {
    totalTokens: Number(run.usageTotalTokens) || 0,
    inputTokens: Number(run.usageInputTokens) || 0,
    outputTokens: Number(run.usageOutputTokens) || 0,
    cacheReadTokens: Number(run.usageCacheReadTokens) || 0,
    cacheWriteTokens: Number(run.usageCacheWriteTokens) || 0,
    estimatedCostUsd: run.usageEstimatedCostUsd != null ? Number(run.usageEstimatedCostUsd) : null,
  };
}
