import React, { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { formatTokens, tokensTooltip, totalTokens, type TokenUsage } from "./lib/tokenUsage";

type StageCard = { stageIndex: number; role: string; status: string };
type RunCard = {
  id: string;
  status: string;
  trigger: string;
  createdAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  currentStageIndex: number;
  errorMessage?: string | null;
  resultSummary?: string | null;
  task?: { id: string; title: string } | null;
  project?: { id: string; name: string } | null;
  stages: StageCard[];
  job?: { status: string; lastError?: string | null; worker?: { id: string; name: string } | null } | null;
  pendingInteractions: number;
  lastLog?: { level: string; message: string; createdAt?: string } | null;
  usage?: TokenUsage | null;
};

const PREFIX = (window as any).routePrefix ?? "/dashboard";
const API_URL = `${PREFIX}/agentiz-runs`;

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  pending: { bg: "#f1f5f9", fg: "#334155" },
  queued: { bg: "#f1f5f9", fg: "#334155" },
  running: { bg: "#fef3c7", fg: "#b45309" },
  waiting_input: { bg: "#ffedd5", fg: "#c2410c" },
  succeeded: { bg: "#d1fae5", fg: "#047857" },
  failed: { bg: "#fee2e2", fg: "#b91c1c" },
  cancelled: { bg: "#f1f5f9", fg: "#64748b" },
  skipped: { bg: "#f1f5f9", fg: "#64748b" },
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const swatch = STATUS_COLORS[status] ?? { bg: "#f1f5f9", fg: "#334155" };
  return (
    <span className="inline-block rounded px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: swatch.bg, color: swatch.fg }}>
      {status}
    </span>
  );
};

/** "Идёт 4 мин" — a run card is read at a glance, so elapsed time beats an absolute timestamp. */
function elapsed(from?: string | null, to?: string | null): string {
  if (!from) return "";
  const start = new Date(from).getTime();
  const end = to ? new Date(to).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ч ${minutes % 60} мин`;
}

const StageStrip: React.FC<{ run: RunCard }> = ({ run }) => (
  <div className="flex flex-wrap items-center gap-1">
    {run.stages.map((stage) => (
      <span
        key={stage.stageIndex}
        title={`#${stage.stageIndex} ${stage.role} — ${stage.status}`}
        className="rounded border px-1.5 py-0.5 text-xs"
        style={{
          backgroundColor: (STATUS_COLORS[stage.status] ?? STATUS_COLORS.pending).bg,
          color: (STATUS_COLORS[stage.status] ?? STATUS_COLORS.pending).fg,
          borderColor: stage.stageIndex === run.currentStageIndex ? "#f59e0b" : "transparent",
        }}
      >
        {stage.stageIndex}. {stage.role}
      </span>
    ))}
  </div>
);

const RunRow: React.FC<{ run: RunCard; live: boolean; onCancel: (run: RunCard) => void; busy: boolean }> = ({ run, live, onCancel, busy }) => (
  <li
    className="rounded-lg border p-3"
    style={run.pendingInteractions > 0 ? { borderColor: "#fdba74", backgroundColor: "#fff7ed" } : undefined}
  >
    <div className="flex flex-wrap items-center gap-2">
      <StatusBadge status={run.status} />
      <a href={`${API_URL}?runId=${run.id}`} className="font-medium underline">
        {run.task?.title ?? "Задача"}
      </a>
      <span className="text-xs text-muted-foreground">{run.project?.name ?? "проект"}</span>
      <span className="text-xs text-muted-foreground">· {run.trigger}</span>
      {run.job?.worker && <span className="text-xs text-muted-foreground">· воркер {run.job.worker.name}</span>}
      {run.job && !run.job.worker && <span className="text-xs text-muted-foreground">· job {run.job.status}</span>}
      <span className="text-xs text-muted-foreground">
        · {live ? `идёт ${elapsed(run.startedAt ?? run.createdAt)}` : `${elapsed(run.startedAt ?? run.createdAt, run.finishedAt)} · ${run.finishedAt ?? run.createdAt ?? ""}`}
      </span>
      {run.usage && totalTokens(run.usage) > 0 && (
        <span className="text-xs text-muted-foreground" title={tokensTooltip(run.usage)}>
          · {formatTokens(totalTokens(run.usage))} ткн
        </span>
      )}
      {run.pendingInteractions > 0 && (
        <a href={`${PREFIX}/agentiz-interactions`} className="rounded px-2 py-0.5 text-xs font-medium underline" style={{ backgroundColor: "#ffedd5", color: "#c2410c" }}>
          ждёт ответа ({run.pendingInteractions})
        </a>
      )}
      {live && (
        <button onClick={() => onCancel(run)} disabled={busy} className="ml-auto rounded border px-2 py-0.5 text-xs disabled:opacity-50">
          Отменить
        </button>
      )}
    </div>
    {run.stages.length > 0 && <div className="mt-2"><StageStrip run={run} /></div>}
    {live && run.lastLog && (
      <p className="mt-2 truncate text-xs text-muted-foreground" title={run.lastLog.message}>
        {run.lastLog.message}
      </p>
    )}
    {!live && (run.errorMessage || run.resultSummary) && (
      <p className="mt-2 truncate text-xs" style={{ color: run.errorMessage ? "#b91c1c" : undefined }} title={run.errorMessage ?? run.resultSummary ?? ""}>
        {run.errorMessage ?? run.resultSummary}
      </p>
    )}
  </li>
);

const AgentizRuns: React.FC = () => {
  const [active, setActive] = useState<RunCard[]>([]);
  const [recent, setRecent] = useState<RunCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const projectId = new URLSearchParams(window.location.search).get("projectId") ?? "";

  const load = useCallback(async () => {
    try {
      const response = await axios.get(API_URL, { params: { _method: "listRuns", projectId: projectId || undefined } });
      setActive(response.data?.data?.active ?? []);
      setRecent(response.data?.data?.recent ?? []);
      setError(null);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Не удалось загрузить запуски");
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval((): void => { void load(); }, 3000);
    return (): void => { window.clearInterval(timer); };
  }, [load]);

  const cancel = useCallback(async (run: RunCard) => {
    setBusy(run.id);
    setError(null);
    try {
      await axios.post(API_URL, { _method: "cancelRun", runId: run.id });
      await load();
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Не удалось отменить запуск");
    } finally {
      setBusy(null);
    }
  }, [load]);

  const waiting = active.filter((run) => run.pendingInteractions > 0).length;

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Запуски</h1>
          <p className="text-sm text-muted-foreground">
            Что идёт прямо сейчас — обновляется каждые 3 секунды.
            {waiting > 0 && <> {waiting} из них ждут ответа.</>}
          </p>
        </div>
        <div className="flex gap-3 text-sm">
          <a href={`${PREFIX}/agentiz-interactions`} className="underline">Нужен ответ</a>
          <a href={`${PREFIX}/agentiz-tasks`} className="underline">Задачи</a>
        </div>
      </div>

      {error && <div className="rounded border p-3 text-sm" style={{ borderColor: "#fecaca", backgroundColor: "#fef2f2", color: "#b91c1c" }}>{error}</div>}

      <div className="rounded-lg border p-4">
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">Идут сейчас ({active.length})</h3>
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">{loaded ? "Сейчас ничего не выполняется." : "Загрузка…"}</p>
        ) : (
          <ul className="space-y-2">
            {active.map((run) => <RunRow key={run.id} run={run} live onCancel={cancel} busy={busy === run.id} />)}
          </ul>
        )}
      </div>

      {recent.length > 0 && (
        <div className="rounded-lg border p-4">
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">Завершились недавно</h3>
          <ul className="space-y-2">
            {recent.map((run) => <RunRow key={run.id} run={run} live={false} onCancel={cancel} busy={false} />)}
          </ul>
        </div>
      )}
    </div>
  );
};

export default AgentizRuns;
