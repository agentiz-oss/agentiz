/**
 * Token spend of a run (accumulated over every attempt) or of one stage (last attempt), as the
 * server sends it. `null`/absent means "never reported" — old runs and executors that report no
 * usage — and must render as nothing, not as 0.
 */
export type TokenUsage = {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  contextWindow?: number;
  estimatedCostUsd?: number | null;
  model?: string;
};

/** "12 340" → "12.3k", "1 234 567" → "1.2M" — a run card is scanned, not read. */
export function formatTokens(value: number | undefined | null): string {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** Full breakdown for a tooltip: every component spelled out with exact numbers. */
export function tokensTooltip(usage: TokenUsage): string {
  const parts = [
    `вход: ${(usage.inputTokens ?? 0).toLocaleString("ru-RU")}`,
    `выход: ${(usage.outputTokens ?? 0).toLocaleString("ru-RU")}`,
    `кэш (чтение): ${(usage.cacheReadTokens ?? 0).toLocaleString("ru-RU")}`,
    `кэш (запись): ${(usage.cacheWriteTokens ?? 0).toLocaleString("ru-RU")}`,
  ];
  if (usage.reasoningTokens) parts.push(`рассуждения: ${usage.reasoningTokens.toLocaleString("ru-RU")}`);
  if (usage.estimatedCostUsd) parts.push(`≈ $${usage.estimatedCostUsd.toFixed(usage.estimatedCostUsd < 0.1 ? 4 : 2)}`);
  return parts.join(" · ");
}

/** Total even when the sender only provided components (an older worker build). */
export function totalTokens(usage: TokenUsage): number {
  if (Number(usage.totalTokens) > 0) return Number(usage.totalTokens);
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}
