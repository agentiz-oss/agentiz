/**
 * Machine-readable pass/fail read off a verdict stage's own output. See
 * `.ai-notes/machine-verdict-plan.md` for the design; this file is the single TS source for the
 * marker format and the prompt instruction that asks for it, read by:
 *
 *   - `AgentPipelineService.buildSnapshot`, which appends `VERDICT_PROMPT_INSTRUCTION` to the
 *     systemPrompt of a stage with `verdict: true`;
 *   - `AgentWorkerApiService`, which calls `extractVerdict` on that stage's own output
 *     (`stageOutputs[i].output.agentResponse`), never on the run's combined `resultSummary` —
 *     another stage's text must not produce a false verdict.
 *
 * The worker's fallback retry (`worker/src/agentiz_worker/main.py`) duplicates the regex in
 * Python — no shared package between the two languages — and must be kept byte-for-byte
 * equivalent with this file; a change to the format touches both in the same commit.
 */

export type RunVerdictValue = 'pass' | 'fail';

export interface ExtractedVerdict {
  verdict: RunVerdictValue | null;
  reason: string | null;
}

/**
 * Appended to a verdict stage's systemPrompt only — roles that never set `stages[].verdict` never
 * see this text, so nobody has to read format instructions for a marker they were not asked for.
 */
export const VERDICT_PROMPT_INSTRUCTION =
  'В самом конце ответа на этой стадии добавь отдельной, последней строкой машиночитаемый '
  + 'вердикт строго в формате `AGENTIZ_VERDICT: pass` или '
  + '`AGENTIZ_VERDICT: fail — причина одной строкой` (без переносов строк внутри причины, без '
  + 'других слов на этой строке). Значение — только pass или fail, ничего третьего.';

/** Same text, used as the worker's one fallback question when the first answer had no marker. */
export const VERDICT_RETRY_PROMPT =
  'Ответь одной строкой строго в формате `AGENTIZ_VERDICT: pass` или '
  + '`AGENTIZ_VERDICT: fail — причина одной строкой`. Без вызовов инструментов, без остального текста.';

// Line-anchored on purpose (open question #2 in the plan): the reason, if any, ends where the
// physical line ends, so a multi-line reason with no explicit terminator cannot be captured.
// Case-insensitive throughout — the value is normalized on read, and being lenient about the
// marker keyword's own case costs nothing.
const VERDICT_LINE_RE = /AGENTIZ_VERDICT:\s*(pass|fail)\s*(?:[—-]\s*(.+?))?\s*$/gim;

/**
 * Searches from the end of the text; the last valid marker line wins over any earlier one (a model
 * that restates the marker before its final line means the final line is the real answer). A line
 * that looks like a marker but does not carry `pass`/`fail` verbatim simply is not a match — it is
 * "corrupted" per the plan, not silently coerced to whichever word is closest.
 */
export function extractVerdict(text: string | null | undefined): ExtractedVerdict {
  if (!text) return { verdict: null, reason: null };
  const re = new RegExp(VERDICT_LINE_RE.source, VERDICT_LINE_RE.flags);
  let last: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    last = match;
    if (match.index === re.lastIndex) re.lastIndex += 1; // guard against zero-width matches
  }
  if (!last) return { verdict: null, reason: null };
  const verdict = last[1].toLowerCase() as RunVerdictValue;
  const reason = last[2]?.trim() || null;
  return { verdict, reason };
}
