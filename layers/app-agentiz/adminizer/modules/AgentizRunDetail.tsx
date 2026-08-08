import React, { useCallback, useEffect, useState } from "react";
import axios from "axios";

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

interface RunDiff {
  id: string;
  baseSha: string | null;
  patch: string | null;
  ops: Array<Record<string, any>> | null;
  stats: { files?: number; insertions?: number; deletions?: number } | null;
  truncated: boolean;
  appliedAt: string | null;
  appliedCommitSha: string | null;
}

interface RunDetails {
  run: AgentRun;
  stages: StageExecution[];
  logs: RunLog[];
  diff: RunDiff | null;
}

const PREFIX = (window as any).routePrefix ?? "/dashboard";
const API_URL = `${PREFIX}/agentiz-runs`;

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  pending: { bg: "#f1f5f9", fg: "#334155" },
  running: { bg: "#fef3c7", fg: "#b45309" },
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

  useEffect(() => {
    setRunId(new URLSearchParams(window.location.search).get("runId") ?? "");
  }, []);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    try {
      const res = await axios.get(API_URL, { params: { _method: "getRunDetails", runId: id } });
      setDetails(res.data?.data ?? null);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Не удалось загрузить запуск");
    }
  }, []);

  useEffect(() => {
    load(runId);
  }, [runId, load]);

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

          {details!.logs.length > 0 && (
            <div className="rounded-lg border p-4">
              <h2 className="mb-3 text-lg font-semibold">Логи</h2>
              <div className="overflow-auto rounded p-2 font-mono text-[11px]" style={{ maxHeight: 420, backgroundColor: "#0f172a", color: "#e2e8f0" }}>
                {details!.logs.map((log) => (
                  <div key={log.id}>
                    <span style={{ color: "#94a3b8" }}>[{log.level}]</span> {log.message}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-lg border p-4">
            <h2 className="mb-3 text-lg font-semibold">Дифф</h2>
            {!details!.diff ? (
              <p className="text-sm text-muted-foreground">Этот запуск ничего не менял в коде.</p>
            ) : (
              <>
                <div className="text-xs text-muted-foreground">
                  от <code>{(details!.diff.baseSha ?? "—").slice(0, 12)}</code>
                  {" · "}
                  {details!.diff.stats?.files ?? details!.diff.ops?.length ?? 0} файл(ов),{" "}
                  +{details!.diff.stats?.insertions ?? 0} −{details!.diff.stats?.deletions ?? 0}
                  {details!.diff.appliedAt
                    ? ` · применено ${new Date(details!.diff.appliedAt).toLocaleString()}, коммит ${(details!.diff.appliedCommitSha ?? "").slice(0, 12)}`
                    : " · в репозиторий не отправлено"}
                </div>
                <ul className="mt-2 space-y-0.5 text-xs">
                  {(details!.diff.ops ?? []).map((op, index) => (
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
                {details!.diff.truncated && (
                  <div className="mt-2 text-xs" style={{ color: "#b45309" }}>
                    Патч обрезан по лимиту размера. Операции сохранены полностью — применяются именно они.
                  </div>
                )}
                {details!.diff.patch && (
                  <pre className="mt-2 max-h-96 overflow-auto rounded border p-2 text-xs" style={{ backgroundColor: "#f8fafc" }}>
                    {details!.diff.patch}
                  </pre>
                )}
                {/* Only offered while the change is still held: applying twice is refused by the
                    server, and a button that always fails is worse than no button. */}
                {!details!.diff.appliedAt && (details!.diff.ops?.length ?? 0) > 0 && (
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
