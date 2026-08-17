import React, { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import { humanInputChoices, missingHumanInputChoice, selectedHumanInputChoice, type HumanInputField } from "./humanInputSchema";
import { DiffViewer } from "./components/diff-viewer";

/**
 * One pipeline run in full: its stages, its log and — when it changed code — the diff, with a
 * button to apply it. Its own page rather than a panel bolted onto the task list, because a run
 * with a full log and a large patch needs room to breathe.
 */
interface AgentRun {
  id: string;
  taskId: string;
  projectId: string;
  status: string;
  trigger: string;
  currentStageIndex: number;
  resultSummary?: string | null;
  responseUrl?: string | null;
  commitUrl?: string | null;
  errorMessage?: string | null;
  createdAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

interface StageExecution {
  id: string;
  stageIndex: number;
  role: string;
  status: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  errorMessage?: string | null;
}

interface RunLog {
  id: string;
  level: string;
  message: string;
  stageExecutionId?: string | null;
  createdAt?: string;
}

/**
 * A page of the log. The server hands back the *tail* by default and a cursor to continue from, so
 * a run that streams its tool calls keeps scrolling instead of stopping at a fixed limit.
 */
interface LogPage {
  logs: RunLog[];
  logsCursor: string | null;
  logsEarlierCursor: string | null;
  logsHasEarlier: boolean;
  logsHasMore: boolean;
}

interface RunDiff {
  id: string;
  baseSha: string | null;
  patch: string | null;
  ops: Array<Record<string, any>> | null;
  stats: { files?: number; insertions?: number; deletions?: number } | null;
  truncated: boolean;
  appliedAt: string | null;
  appliedCommitSha: string | null;
  revision?: number | null;
  treeSha?: string | null;
  patchSizeBytes?: number | null;
  patchSha256?: string | null;
}

interface WorkspaceProposal {
  id: string;
  revision: number;
  status: string;
  workspacePath: string;
  baseSha: string | null;
  baseBranch: string | null;
  expectedTreeSha: string | null;
  targetMode: "current" | "new";
  targetBranch: string | null;
  commitMessage: string;
  decisionActor?: string | null;
  decisionAt?: string | null;
  lastError?: string | null;
  pushedCommitSha?: string | null;
}

interface RunInteraction {
  id: string;
  stageExecutionId: string;
  source: string;
  message: string;
  requestedSchema: {
    type: "object";
    properties?: Record<string, HumanInputField>;
    required?: string[];
  };
  status: string;
  responseAction?: "accept" | "decline" | "cancel" | null;
  responseContent?: Record<string, unknown> | null;
  answeredByName?: string | null;
  answeredAt?: string | null;
  deliveredAt?: string | null;
  createdAt?: string;
}

interface RunDetails {
  run: AgentRun;
  stages: StageExecution[];
  diff: RunDiff | null;
  interactions: RunInteraction[];
  proposal: WorkspaceProposal | null;
  revisions: RunDiff[];
  latestDiff: RunDiff | null;
}

const PREFIX = (window as any).routePrefix ?? "/dashboard";
const API_URL = `${PREFIX}/agentiz-runs`;

/** How close to the bottom still counts as "following the log" — a reader who scrolled up keeps
 *  their place instead of being yanked down by the next line. */
const AUTOSCROLL_SLACK_PX = 40;

const LOG_LEVEL_COLORS: Record<string, string> = {
  debug: "#64748b",
  info: "#94a3b8",
  warn: "#fbbf24",
  error: "#f87171",
};

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  pending: { bg: "#f1f5f9", fg: "#334155" },
  running: { bg: "#fef3c7", fg: "#b45309" },
  waiting_input: { bg: "#ffedd5", fg: "#c2410c" },
  answered: { bg: "#dbeafe", fg: "#1d4ed8" },
  delivered: { bg: "#d1fae5", fg: "#047857" },
  succeeded: { bg: "#d1fae5", fg: "#047857" },
  failed: { bg: "#fee2e2", fg: "#b91c1c" },
  cancelled: { bg: "#f1f5f9", fg: "#64748b" },
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const swatch = STATUS_COLORS[status] ?? { bg: "#f1f5f9", fg: "#334155" };
  return (
    <span className="inline-block rounded px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: swatch.bg, color: swatch.fg }}>
      {status}
    </span>
  );
};

const AgentizRunDetail: React.FC = () => {
  const [runId, setRunId] = useState("");
  const [details, setDetails] = useState<RunDetails | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, Record<string, unknown>>>({});
  const [reviewComment, setReviewComment] = useState("");
  const [targetBranch, setTargetBranch] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  // The log is its own state, appended to rather than replaced: it is the one part of this screen
  // that grows while the run is alive, and the poll tick asks only for what came after `cursor`.
  const [logs, setLogs] = useState<RunLog[]>([]);
  const [logsEarlier, setLogsEarlier] = useState<{ cursor: string | null; hasMore: boolean }>({ cursor: null, hasMore: false });
  const cursor = useRef<string | null>(null);
  const logBox = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  const distanceFromBottom = useRef<number | null>(null);

  useEffect(() => {
    setRunId(new URLSearchParams(window.location.search).get("runId") ?? "");
  }, []);

  const applyLogPage = useCallback((page: Partial<LogPage> | null, mode: "reset" | "append" | "prepend") => {
    const rows = page?.logs ?? [];
    if (mode === "reset") {
      setLogs(rows);
      setLogsEarlier({ cursor: page?.logsEarlierCursor ?? null, hasMore: Boolean(page?.logsHasEarlier) });
    } else if (rows.length > 0) {
      // The same line can arrive twice when a "load earlier" page overlaps the tail already shown.
      setLogs((current) => {
        const known = new Set(current.map((log) => log.id));
        const fresh = rows.filter((log) => !known.has(log.id));
        return mode === "append" ? [...current, ...fresh] : [...fresh, ...current];
      });
      if (mode === "prepend") {
        setLogsEarlier({ cursor: page?.logsEarlierCursor ?? null, hasMore: Boolean(page?.logsHasEarlier) });
      }
    } else if (mode === "prepend") {
      setLogsEarlier({ cursor: null, hasMore: false });
    }
    // A delta page with nothing in it carries no cursor — the previous one is still the position.
    if (mode !== "prepend" && page?.logsCursor) cursor.current = page.logsCursor;
  }, []);

  const load = useCallback(async (id: string, options: { follow?: boolean } = {}) => {
    if (!id) return;
    const follow = options.follow === true && cursor.current !== null;
    try {
      const res = await axios.get(API_URL, {
        params: { _method: "getRunDetails", runId: id, ...(follow ? { logsAfter: cursor.current } : {}) },
      });
      const next = res.data?.data ?? null;
      setDetails(next);
      applyLogPage(next, follow ? "append" : "reset");
      if (next?.proposal) {
        setTargetBranch(next.proposal.targetBranch ?? next.proposal.baseBranch ?? "");
        setCommitMessage(next.proposal.commitMessage ?? "");
      }
      if (next?.interactions) {
        setAnswers((current: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> => {
          const merged = { ...current };
          for (const interaction of next.interactions as RunInteraction[]) {
            if (merged[interaction.id]) continue;
            const defaults: Record<string, unknown> = {};
            for (const [name, field] of Object.entries(interaction.requestedSchema?.properties ?? {})) {
              if (field.default !== undefined) defaults[name] = field.default;
              else if (field.type === "boolean") defaults[name] = false;
              else defaults[name] = "";
            }
            merged[interaction.id] = defaults;
          }
          return merged;
        });
      }
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Не удалось загрузить запуск");
    }
  }, [applyLogPage]);

  const loadEarlierLogs = useCallback(async () => {
    if (!runId || !logsEarlier.cursor) return;
    // Remember where the reader is relative to the bottom, so inserting older lines above does not
    // move the line they were looking at.
    distanceFromBottom.current = logBox.current ? logBox.current.scrollHeight - logBox.current.scrollTop : null;
    try {
      const res = await axios.get(API_URL, {
        params: { _method: "getRunLogs", runId, before: logsEarlier.cursor },
      });
      applyLogPage(res.data?.data ?? null, "prepend");
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Не удалось загрузить ранние строки");
    }
  }, [applyLogPage, logsEarlier.cursor, runId]);

  useEffect(() => {
    cursor.current = null;
    following.current = true;
    load(runId);
  }, [runId, load]);

  useEffect(() => {
    if (!runId) return undefined;
    const timer = window.setInterval((): void => { void load(runId, { follow: true }); }, 2500);
    return (): void => { window.clearInterval(timer); };
  }, [runId, load]);

  // Follow the tail unless the reader has scrolled away from it.
  useEffect(() => {
    const box = logBox.current;
    if (!box) return;
    if (distanceFromBottom.current !== null) {
      box.scrollTop = box.scrollHeight - distanceFromBottom.current;
      distanceFromBottom.current = null;
      return;
    }
    if (following.current) box.scrollTop = box.scrollHeight;
  }, [logs]);

  const answerInteraction = useCallback(async (interaction: RunInteraction, action: "accept" | "decline" | "cancel") => {
    const content = answers[interaction.id] ?? {};
    const missingChoice = action === "accept" ? missingHumanInputChoice(interaction.requestedSchema.properties, content) : null;
    if (missingChoice) {
      setError(`Выберите вариант для поля «${missingChoice}» или заполните поле Other.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await axios.post(API_URL, {
        _method: "answerInteraction",
        interactionId: interaction.id,
        action,
        content: action === "accept" ? content : null,
      });
      await load(runId);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Не удалось отправить ответ");
    } finally {
      setBusy(false);
    }
  }, [answers, load, runId]);

  const cancelRun = useCallback(async () => {
    if (!runId) return;
    setBusy(true);
    setError(null);
    try {
      await axios.post(API_URL, { _method: "cancelRun", runId });
      await load(runId);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Не удалось отменить запуск");
    } finally {
      setBusy(false);
    }
  }, [runId, load]);

  const applyRunDiff = useCallback(async () => {
    if (!runId) return;
    if (!window.confirm("Применить изменения в репозиторий? Повторно это сделать нельзя.")) return;
    setBusy(true);
    setError(null);
    try {
      await axios.post(API_URL, { _method: "applyRunDiff", runId });
      await load(runId);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Не удалось применить изменения");
    } finally {
      setBusy(false);
    }
  }, [runId, load]);

  const proposalAction = useCallback(async (method: string, extra: Record<string, unknown> = {}) => {
    const proposal = details?.proposal;
    if (!proposal) return;
    if (method === "rejectWorkspaceProposal" && !window.confirm(
      `Все отслеживаемые изменения в ${proposal.workspacePath} будут возвращены к ${proposal.baseSha}, новые неотслеживаемые файлы будут удалены. Игнорируемые файлы сохранятся. Продолжить?`,
    )) return;
    setBusy(true);
    setError(null);
    try {
      const response = await axios.post(API_URL, { _method: method, proposalId: proposal.id, revision: proposal.revision, ...extra });
      if (method === "continueWorkspaceProposal" && response.data?.data?.id) {
        window.location.href = `${API_URL}?runId=${response.data.data.id}`;
        return;
      }
      await load(runId);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Действие review не удалось");
    } finally {
      setBusy(false);
    }
  }, [details?.proposal, load, runId]);

  if (!runId) {
    return (
      <div className="space-y-4 p-6">
        <h1 className="text-3xl font-bold tracking-tight">Запуск</h1>
        <p className="text-sm text-muted-foreground">
          Откройте запуск со страницы задачи или проекта — этому экрану нужен <code>?runId=…</code> в адресе.
        </p>
      </div>
    );
  }

  const run = details?.run;
  const displayedDiff = details?.proposal ? details.latestDiff : details?.diff;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Запуск</h1>
          {run && (
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <StatusBadge status={run.status} /> {run.trigger} · {run.createdAt}
            </p>
          )}
        </div>
        {run && (
          <a href={`${PREFIX}/agentiz-tasks`} className="text-xs underline">
            ← к задачам
          </a>
        )}
      </div>

      {error && <div className="rounded border p-3 text-sm" style={{ borderColor: "#fecaca", backgroundColor: "#fef2f2", color: "#b91c1c" }}>{error}</div>}

      {!details && !error && <p className="text-sm text-muted-foreground">Загрузка…</p>}

      {run && (
        <>
          <div className="rounded-lg border p-4">
            {run.resultSummary && (
              <pre className="whitespace-pre-wrap text-sm text-muted-foreground">{run.resultSummary}</pre>
            )}
            {run.errorMessage && <div className="mt-2 text-sm" style={{ color: "#dc2626" }}>{run.errorMessage}</div>}
            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
              {run.commitUrl && (
                <a href={run.commitUrl} target="_blank" rel="noreferrer" className="underline">
                  Коммит
                </a>
              )}
              {run.responseUrl && (
                <a href={run.responseUrl} target="_blank" rel="noreferrer" className="underline">
                  Ответ в трекере
                </a>
              )}
              {run.status !== "succeeded" && run.status !== "failed" && run.status !== "cancelled" && (
                <button onClick={cancelRun} disabled={busy} className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50">
                  Отменить запуск
                </button>
              )}
            </div>
          </div>

          {details!.proposal && (
            <div className="rounded-lg border p-4" style={{ borderColor: "#c4b5fd", backgroundColor: "#faf5ff" }}>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold">Проверка workspace-изменений</h2>
                <StatusBadge status={details!.proposal.status} />
                <span className="text-xs text-muted-foreground">ревизия {details!.proposal.revision}</span>
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                <code>{details!.proposal.workspacePath}</code> · {details!.proposal.baseBranch ?? "—"}@{(details!.proposal.baseSha ?? "—").slice(0, 12)}
                {details!.proposal.expectedTreeSha && <> · tree <code>{details!.proposal.expectedTreeSha.slice(0, 12)}</code></>}
              </div>
              {details!.proposal.lastError && <div className="mt-2 text-sm" style={{ color: "#b91c1c" }}>{details!.proposal.lastError}</div>}
              {details!.revisions.length > 1 && (
                <div className="mt-2 text-xs">История: {details!.revisions.map((revision) => (
                  <span key={revision.id} className="mr-2">#{revision.revision}: {revision.stats?.files ?? 0} файл(ов)</span>
                ))}</div>
              )}
              {details!.proposal.status === "waiting_review" && (
                <div className="mt-3 space-y-3">
                  <div className="grid gap-2 md:grid-cols-2">
                    <label className="text-xs">Ветка
                      <input value={targetBranch} onChange={(event) => setTargetBranch(event.target.value)} disabled={details!.proposal.targetMode === "current"} className="mt-1 w-full rounded border px-2 py-1.5" />
                    </label>
                    <label className="text-xs">Commit message
                      <textarea value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} rows={3} className="mt-1 w-full rounded border px-2 py-1.5" />
                    </label>
                  </div>
                  <button
                    onClick={() => proposalAction("approveWorkspaceProposal", { targetBranch, commitMessage })}
                    disabled={busy || displayedDiff?.truncated || !commitMessage.trim()}
                    className="rounded border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                  >Подтвердить commit и push</button>
                  <div className="flex flex-wrap gap-2">
                    <textarea value={reviewComment} onChange={(event) => setReviewComment(event.target.value)} placeholder="Что нужно доработать" rows={2} className="min-w-72 flex-1 rounded border px-2 py-1.5 text-sm" />
                    <button onClick={() => proposalAction("continueWorkspaceProposal", { comment: reviewComment })} disabled={busy || !reviewComment.trim()} className="rounded border px-3 py-1.5 text-xs disabled:opacity-50">Продолжить работу</button>
                  </div>
                  <button onClick={() => proposalAction("rejectWorkspaceProposal")} disabled={busy} className="rounded border px-3 py-1.5 text-xs disabled:opacity-50" style={{ borderColor: "#ef4444", color: "#b91c1c" }}>Отклонить и вернуть workspace</button>
                </div>
              )}
              {details!.proposal.status === "push_failed" && (
                <div className="mt-3 flex gap-2">
                  <button onClick={() => proposalAction("approveWorkspaceProposal", { targetBranch, commitMessage })} disabled={busy} className="rounded border px-3 py-1.5 text-xs">Повторить push</button>
                  <button onClick={() => proposalAction("rejectWorkspaceProposal")} disabled={busy} className="rounded border px-3 py-1.5 text-xs" style={{ borderColor: "#ef4444", color: "#b91c1c" }}>Вернуть workspace</button>
                </div>
              )}
              {details!.proposal.status === "reset_failed" && (
                <button onClick={() => proposalAction("rejectWorkspaceProposal")} disabled={busy} className="mt-3 rounded border px-3 py-1.5 text-xs" style={{ borderColor: "#ef4444", color: "#b91c1c" }}>Повторить безопасный reset</button>
              )}
            </div>
          )}

          {details!.interactions.length > 0 && (
            <div className="rounded-lg border p-4">
              <h2 className="mb-3 text-lg font-semibold">Вопросы агенту</h2>
              <ul className="space-y-3">
                {details!.interactions.map((interaction) => {
                  const stage = details!.stages.find((item) => item.id === interaction.stageExecutionId);
                  return (
                    <li key={interaction.id} className="rounded border p-3 text-sm" style={interaction.status === "pending" ? { borderColor: "#fdba74", backgroundColor: "#fff7ed" } : undefined}>
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge status={interaction.status} />
                        <span className="font-medium">{stage ? `#${stage.stageIndex} ${stage.role}` : "Стадия"}</span>
                        <span className="text-xs text-muted-foreground">{interaction.source} · {interaction.createdAt}</span>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap">{interaction.message}</p>
                      {interaction.status === "pending" && (
                        <div className="mt-3 space-y-2">
                          {Object.entries(interaction.requestedSchema?.properties ?? {}).map(([name, field]) => {
                            const value = answers[interaction.id]?.[name];
                            const label = field.title ?? name;
                            const choices = humanInputChoices(field);
                            return (
                              <label key={name} className="block text-xs">
                                <span className="block font-medium">{label}{interaction.requestedSchema.required?.includes(name) ? " *" : ""}</span>
                                {field.description && <span className="block text-muted-foreground">{field.description}</span>}
                                {choices.length > 0 ? (
                                  <select value={selectedHumanInputChoice(choices, value)} onChange={(event) => {
                                    const index = Number(event.target.value);
                                    const next = Number.isInteger(index) && choices[index] ? choices[index].value : "";
                                    setAnswers((all) => ({ ...all, [interaction.id]: { ...all[interaction.id], [name]: next } }));
                                  }} className="mt-1 w-full rounded border px-2 py-1.5 text-sm">
                                    <option value="">Выберите…</option>
                                    {choices.map((choice, index) => <option key={String(index)} value={String(index)}>{choice.label}</option>)}
                                  </select>
                                ) : field.type === "boolean" ? (
                                  <input type="checkbox" checked={Boolean(value)} onChange={(event) => setAnswers((all) => ({ ...all, [interaction.id]: { ...all[interaction.id], [name]: event.target.checked } }))} className="mt-1" />
                                ) : (
                                  <input type={field.type === "number" || field.type === "integer" ? "number" : "text"} value={String(value ?? "")} onChange={(event) => {
                                    const raw = event.target.value;
                                    const next: unknown = field.type === "number" || field.type === "integer" ? (raw === "" ? "" : Number(raw)) : raw;
                                    setAnswers((all) => ({ ...all, [interaction.id]: { ...all[interaction.id], [name]: next } }));
                                  }} className="mt-1 w-full rounded border px-2 py-1.5 text-sm" />
                                )}
                              </label>
                            );
                          })}
                          <div className="flex flex-wrap gap-2">
                            <button onClick={() => answerInteraction(interaction, "accept")} disabled={busy} className="rounded border px-3 py-1.5 text-xs font-medium disabled:opacity-50">Ответить</button>
                            <button onClick={() => answerInteraction(interaction, "decline")} disabled={busy} className="rounded border px-3 py-1.5 text-xs disabled:opacity-50">Отказаться</button>
                            <button onClick={() => answerInteraction(interaction, "cancel")} disabled={busy} className="rounded border px-3 py-1.5 text-xs disabled:opacity-50">Отменить запрос</button>
                          </div>
                        </div>
                      )}
                      {interaction.responseAction && interaction.status !== "pending" && (
                        <div className="mt-2 rounded p-2 text-xs" style={{ backgroundColor: "#f8fafc" }}>
                          Ответ: <strong>{interaction.responseAction}</strong>
                          {interaction.responseContent && <pre className="mt-1 whitespace-pre-wrap">{JSON.stringify(interaction.responseContent, null, 2)}</pre>}
                          {interaction.answeredByName && <div className="text-muted-foreground">{interaction.answeredByName} · {interaction.answeredAt}{interaction.deliveredAt ? ` · доставлен ${interaction.deliveredAt}` : ""}</div>}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="rounded-lg border p-4">
            <h2 className="mb-3 text-lg font-semibold">Стадии</h2>
            {details!.stages.length === 0 && <p className="text-sm text-muted-foreground">Стадий пока нет.</p>}
            <ul className="space-y-2">
              {details!.stages.map((stage) => (
                <li key={stage.id} className="rounded border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={stage.status} />
                    <span className="font-medium">#{stage.stageIndex} {stage.role}</span>
                    {stage.startedAt && (
                      <span className="text-xs text-muted-foreground">
                        {stage.startedAt}{stage.finishedAt ? ` → ${stage.finishedAt}` : ""}
                      </span>
                    )}
                  </div>
                  {stage.errorMessage && <div className="mt-1 text-xs" style={{ color: "#dc2626" }}>{stage.errorMessage}</div>}
                </li>
              ))}
            </ul>
          </div>

          {logs.length > 0 && (
            <div className="rounded-lg border p-4">
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-semibold">Логи</h2>
                {logsEarlier.hasMore && (
                  <button onClick={loadEarlierLogs} className="rounded border px-2 py-0.5 text-xs">
                    Показать более ранние
                  </button>
                )}
                <span className="text-xs text-muted-foreground">{logs.length} строк(и)</span>
              </div>
              <div
                ref={logBox}
                onScroll={(event) => {
                  const box = event.currentTarget;
                  following.current = box.scrollHeight - box.scrollTop - box.clientHeight < AUTOSCROLL_SLACK_PX;
                }}
                className="overflow-auto rounded p-2 font-mono text-[11px]"
                style={{ maxHeight: 420, backgroundColor: "#0f172a", color: "#e2e8f0" }}
              >
                {logs.map((log) => (
                  <div key={log.id}>
                    <span style={{ color: LOG_LEVEL_COLORS[log.level] ?? "#94a3b8" }}>[{log.level}]</span> {log.message}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-lg border p-4">
            <h2 className="mb-3 text-lg font-semibold">Дифф</h2>
            {!displayedDiff ? (
              <p className="text-sm text-muted-foreground">Этот запуск ничего не менял в коде.</p>
            ) : (
              <>
                <div className="text-xs text-muted-foreground">
                  от <code>{(displayedDiff.baseSha ?? "—").slice(0, 12)}</code>
                  {" · "}
                  {displayedDiff.stats?.files ?? displayedDiff.ops?.length ?? 0} файл(ов),{" "}
                  +{displayedDiff.stats?.insertions ?? 0} −{displayedDiff.stats?.deletions ?? 0}
                  {displayedDiff.appliedAt
                    ? ` · применено ${new Date(displayedDiff.appliedAt).toLocaleString()}, коммит ${(displayedDiff.appliedCommitSha ?? "").slice(0, 12)}`
                    : " · в репозиторий не отправлено"}
                </div>
                <ul className="mt-2 space-y-0.5 text-xs">
                  {(displayedDiff.ops ?? []).map((op, index) => (
                    <li key={index}>
                      {/* One glyph per operation: the list is scanned, not read. */}
                      <span className="mr-1 font-mono">
                        {op.op === "delete" ? "−" : op.op === "rename" ? "→" : "~"}
                      </span>
                      <code>{op.op === "rename" ? `${op.from} → ${op.to}` : op.path}</code>
                      {op.mode && <span className="ml-1 text-muted-foreground">{op.mode}</span>}
                    </li>
                  ))}
                </ul>
                {displayedDiff.truncated && (
                  <div className="mt-2 text-xs" style={{ color: "#b45309" }}>
                    Патч обрезан по лимиту размера. Операции сохранены полностью — применяются именно они.
                  </div>
                )}
                {displayedDiff.patch && (
                  <div className="mt-3">
                    <DiffViewer patch={displayedDiff.patch} persistKey="agentiz.diffViewMode" />
                  </div>
                )}
                {/* Only offered while the change is still held: applying twice is refused by the
                    server, and a button that always fails is worse than no button. */}
                {!details!.proposal && !displayedDiff.appliedAt && (displayedDiff.ops?.length ?? 0) > 0 && (
                  <button
                    onClick={applyRunDiff}
                    disabled={busy}
                    className="mt-2 rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                  >
                    Применить в репозиторий
                  </button>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default AgentizRunDetail;
