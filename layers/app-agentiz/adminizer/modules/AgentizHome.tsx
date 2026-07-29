import React, { useCallback, useEffect, useState } from "react";
import axios from "axios";

interface AgentProject {
  id: string;
  name: string;
  slug: string;
  repoProvider: string;
  repoConfig?: { owner?: string; repo?: string };
  isActive: boolean;
  lastSyncedAt?: string | null;
}

interface AgentTask {
  id: string;
  externalId: string;
  externalUrl?: string | null;
  title: string;
  tags?: string[] | null;
  status: string;
  externalStatus?: string | null;
  /** Adapter key the task was mirrored from (github/gitlab/local/...). */
  sourceType?: string | null;
  /** Human name of that task manager, resolved server-side from the taskManagers collection. */
  sourceTitle?: string;
  /** Full origin label, e.g. "GitLab Issues · my-group/my-project". */
  sourceName?: string | null;
  updatedAt?: string;
}

interface AgentRun {
  id: string;
  status: string;
  trigger: string;
  resultSummary?: string | null;
  responseUrl?: string | null;
  commitUrl?: string | null;
  errorMessage?: string | null;
  createdAt?: string;
}

interface AgentWorker {
  id: string;
  name: string;
  instanceId?: string | null;
  kind: string;
  status: string;
  tokenPrefix?: string | null;
  version?: string | null;
  hostname?: string | null;
  lastSeenAt?: string | null;
  registeredAt?: string | null;
  claimedJobsCount?: number;
  allowedProjectIds?: string[] | null;
}

/** Server-issued secret shown once, together with the command that consumes it. */
interface IssuedToken {
  workerName: string;
  token: string;
  workerApiUrl: string;
}

/** Matches AgentWorker.contactState() on the server: a worker polls constantly, so a gap means down. */
const OFFLINE_AFTER_MS = 5 * 60 * 1000;

function contactLabel(worker: AgentWorker): string {
  if (!worker.lastSeenAt) return "ещё не подключался";
  const gap = Date.now() - new Date(worker.lastSeenAt).getTime();
  if (gap <= OFFLINE_AFTER_MS) return "на связи";
  return `не в сети (последний раз ${new Date(worker.lastSeenAt).toLocaleString()})`;
}

const API_URL = `${(window as any).routePrefix ?? "/dashboard"}/agentiz`;

/**
 * Inline styles rather than Tailwind palette classes: Adminizer serves a prebuilt, restricted
 * Tailwind bundle in which `bg-emerald-100` / `text-red-700` and friends do not exist, so a
 * class-based palette renders as flat grey. Layout utilities are present and still used.
 */
const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  new: { bg: "#f1f5f9", fg: "#334155" },
  queued: { bg: "#dbeafe", fg: "#1d4ed8" },
  running: { bg: "#fef3c7", fg: "#b45309" },
  waiting_review: { bg: "#ede9fe", fg: "#6d28d9" },
  done: { bg: "#d1fae5", fg: "#047857" },
  succeeded: { bg: "#d1fae5", fg: "#047857" },
  failed: { bg: "#fee2e2", fg: "#b91c1c" },
  cancelled: { bg: "#f1f5f9", fg: "#64748b" },
  ignored: { bg: "#f1f5f9", fg: "#64748b" },
  active: { bg: "#d1fae5", fg: "#047857" },
  paused: { bg: "#fef3c7", fg: "#b45309" },
  revoked: { bg: "#fee2e2", fg: "#b91c1c" },
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const swatch = STATUS_COLORS[status] ?? { bg: "#f1f5f9", fg: "#334155" };
  return (
    <span
      className="inline-block rounded px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: swatch.bg, color: swatch.fg }}
    >
      {status}
    </span>
  );
};

const AgentizHome: React.FC = () => {
  const [projects, setProjects] = useState<AgentProject[]>([]);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");
  const [workers, setWorkers] = useState<AgentWorker[]>([]);
  const [workerApi, setWorkerApi] = useState<{ enabled: boolean; url: string }>({ enabled: false, url: "" });
  const [newWorkerName, setNewWorkerName] = useState("");
  /** An issued token is returned by the server exactly once — keep it on screen until dismissed. */
  const [issuedToken, setIssuedToken] = useState<IssuedToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await axios.get(API_URL, { params: { _method: "getProjects" } });
      const items: AgentProject[] = res.data?.data ?? [];
      setProjects(items);
      if (items.length > 0) setSelectedProjectId((current) => current || items[0].id);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Не удалось загрузить проекты");
    }
  }, []);

  const fetchTasks = useCallback(async (projectId: string) => {
    if (!projectId) return;
    try {
      const res = await axios.get(API_URL, { params: { _method: "getTasks", projectId } });
      setTasks(res.data?.data ?? []);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Не удалось загрузить задачи");
    }
  }, []);

  const fetchRuns = useCallback(async (taskId: string) => {
    if (!taskId) {
      setRuns([]);
      return;
    }
    try {
      const res = await axios.get(API_URL, { params: { _method: "getRuns", taskId } });
      setRuns(res.data?.data ?? []);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Не удалось загрузить запуски");
    }
  }, []);

  const fetchWorkers = useCallback(async () => {
    try {
      const res = await axios.get(API_URL, { params: { _method: "getWorkers" } });
      setWorkers(res.data?.data ?? []);
      setWorkerApi({
        enabled: Boolean(res.data?.meta?.workerApiEnabled),
        url: res.data?.meta?.workerApiUrl ?? "",
      });
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Не удалось загрузить воркеров");
    }
  }, []);

  const workerAction = useCallback(
    async (method: string, worker: AgentWorker, extra: Record<string, unknown> = {}) => {
      setBusy(true);
      setError(null);
      try {
        const res = await axios.post(API_URL, { _method: method, workerId: worker.id, ...extra });
        if (res.data?.data?.token) {
          setIssuedToken({
            workerName: worker.name,
            token: res.data.data.token,
            workerApiUrl: res.data.data.workerApiUrl ?? workerApi.url,
          });
        }
        await fetchWorkers();
      } catch (e: any) {
        setError(e?.response?.data?.message ?? "Действие над воркером не удалось");
      } finally {
        setBusy(false);
      }
    },
    [fetchWorkers, workerApi.url],
  );

  /**
   * Creating a worker is the whole onboarding: the token comes back once, right here.
   * The name is a label, not an identifier, so an empty field gets a default instead of blocking
   * the button — nothing about it is worth stopping the flow for.
   */
  const createWorker = useCallback(async () => {
    const name = newWorkerName.trim() || `worker-${workers.length + 1}`;
    setBusy(true);
    setError(null);
    try {
      const res = await axios.post(API_URL, { _method: "createWorker", name });
      setIssuedToken({
        workerName: name,
        token: res.data?.data?.token ?? "",
        workerApiUrl: res.data?.data?.workerApiUrl ?? workerApi.url,
      });
      setNewWorkerName("");
      await fetchWorkers();
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Не удалось создать воркера");
    } finally {
      setBusy(false);
    }
  }, [fetchWorkers, newWorkerName, workerApi.url, workers.length]);

  useEffect(() => {
    fetchProjects();
    fetchWorkers();
  }, [fetchProjects, fetchWorkers]);

  useEffect(() => {
    fetchTasks(selectedProjectId);
    setSelectedTaskId("");
    setRuns([]);
  }, [selectedProjectId, fetchTasks]);

  useEffect(() => {
    fetchRuns(selectedTaskId);
  }, [selectedTaskId, fetchRuns]);

  const syncProject = useCallback(async () => {
    if (!selectedProjectId) return;
    setBusy(true);
    setError(null);
    try {
      await axios.post(API_URL, { _method: "syncProject", projectId: selectedProjectId });
      await fetchTasks(selectedProjectId);
      await fetchProjects();
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Синхронизация не удалась");
    } finally {
      setBusy(false);
    }
  }, [selectedProjectId, fetchTasks, fetchProjects]);

  const runTask = useCallback(
    async (taskId: string) => {
      setBusy(true);
      setError(null);
      try {
        await axios.post(API_URL, { _method: "runTask", taskId });
        await fetchTasks(selectedProjectId);
        setSelectedTaskId(taskId);
        await fetchRuns(taskId);
      } catch (e: any) {
        setError(e?.response?.data?.message ?? "Запуск пайплайна не удался");
      } finally {
        setBusy(false);
      }
    },
    [selectedProjectId, fetchTasks, fetchRuns],
  );

  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Agentiz</h1>
        <p className="text-sm text-muted-foreground">
          Проекты, задачи из внешних трекеров и запуски агентных пайплайнов.
        </p>
      </div>

      {error && <div className="rounded border p-3 text-sm" style={{ borderColor: "#fecaca", backgroundColor: "#fef2f2", color: "#b91c1c" }}>{error}</div>}

      <div className="rounded-lg border p-4">
        <h2 className="mb-3 text-lg font-semibold">Проекты</h2>
        {projects.length === 0 && <p className="text-sm text-muted-foreground">Пока нет ни одного проекта.</p>}
        <div className="flex flex-wrap gap-2">
          {projects.map((project) => (
            <button
              key={project.id}
              onClick={() => setSelectedProjectId(project.id)}
              className={`rounded border px-3 py-2 text-left text-sm ${
                project.id === selectedProjectId ? "border-primary bg-primary/5" : ""
              }`}
            >
              <div className="font-medium">{project.name}</div>
              <div className="text-xs text-muted-foreground">
                {project.repoProvider}: {project.repoConfig?.owner}/{project.repoConfig?.repo}
              </div>
            </button>
          ))}
        </div>
        {selectedProject && (
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={syncProject}
              disabled={busy}
              className="rounded border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            >
              {busy ? "Синхронизация…" : "Синхронизировать задачи"}
            </button>
            <span className="text-xs text-muted-foreground">
              Последняя синхронизация: {selectedProject.lastSyncedAt ?? "никогда"}
            </span>
          </div>
        )}
      </div>

      <div className="rounded-lg border p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Воркеры</h2>
          <div className="flex items-center gap-2">
            <input
              value={newWorkerName}
              onChange={(event) => setNewWorkerName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") createWorker();
              }}
              placeholder="Название (необязательно)"
              className="rounded border px-2 py-1 text-xs"
            />
            <button
              onClick={createWorker}
              disabled={busy}
              className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
            >
              Новый воркер
            </button>
          </div>
        </div>

        {!workerApi.enabled && (
          <p className="mb-3 text-xs text-muted-foreground">
            Worker API выключен (AGENTIZ_WORKER_API_ENABLED=false) — внешние воркеры не смогут подключиться,
            очередь разбирает встроенный воркер.
          </p>
        )}

        {issuedToken && (
          <div className="mb-3 rounded border p-3 text-sm" style={{ borderColor: "#fcd34d", backgroundColor: "#fffbeb" }}>
            <div className="font-medium" style={{ color: "#78350f" }}>
              Токен воркера «{issuedToken.workerName}» — показывается один раз
            </div>
            <code className="mt-1 block break-all rounded px-2 py-1 text-xs" style={{ backgroundColor: "#ffffff" }}>{issuedToken.token}</code>
            <div className="mt-2 text-xs" style={{ color: "#78350f" }}>Запустите воркер с этим токеном:</div>
            <code className="mt-1 block break-all rounded px-2 py-1 text-xs" style={{ backgroundColor: "#ffffff" }}>
              {`AGENTIZ_URL=${issuedToken.workerApiUrl} AGENTIZ_TOKEN=${issuedToken.token} agentiz-worker run`}
            </code>
            <button onClick={() => setIssuedToken(null)} className="mt-2 rounded border px-2 py-1 text-xs">
              Я скопировал
            </button>
          </div>
        )}

        {workers.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Воркеров нет. Нажмите «Новый воркер» — панель выдаст токен, с которым воркер сразу подключится.
          </p>
        )}
        <ul className="space-y-2">
          {workers.map((worker) => (
            <li key={worker.id} className="rounded border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={worker.status} />
                <span className="font-medium">{worker.name}</span>
                <span className="text-xs text-muted-foreground">
                  {worker.kind}
                  {worker.instanceId ? ` · ${worker.instanceId}` : ""}
                  {worker.version ? ` · v${worker.version}` : ""}
                  {worker.tokenPrefix ? ` · ${worker.tokenPrefix}…` : " · без токена"}
                </span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {contactLabel(worker)} · взято job: {worker.claimedJobsCount ?? 0} ·
                проекты:{" "}
                {worker.allowedProjectIds?.length
                  ? worker.allowedProjectIds
                      .map((id) => projects.find((p) => p.id === id)?.name ?? id)
                      .join(", ")
                  : "все"}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {worker.status === "paused" && (
                  <button
                    onClick={() => workerAction("resumeWorker", worker)}
                    disabled={busy}
                    className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                  >
                    Возобновить
                  </button>
                )}
                {worker.status === "active" && (
                  <button
                    onClick={() => workerAction("pauseWorker", worker, { reason: "paused from admin panel" })}
                    disabled={busy}
                    className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                  >
                    Пауза
                  </button>
                )}
                {worker.status !== "revoked" && worker.kind !== "local" && (
                  <>
                    <button
                      onClick={() => workerAction("rotateWorkerToken", worker)}
                      disabled={busy}
                      className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                    >
                      Перевыпустить токен
                    </button>
                    <button
                      onClick={() => {
                        if (window.confirm(`Отозвать доступ воркера «${worker.name}»? Токен перестанет работать.`)) {
                          workerAction("revokeWorker", worker, { reason: "revoked from admin panel" });
                        }
                      }}
                      disabled={busy}
                      className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50" style={{ borderColor: "#fca5a5", color: "#b91c1c" }}
                    >
                      Отозвать
                    </button>
                  </>
                )}
                {worker.kind !== "local" && (
                  <button
                    onClick={() => {
                      if (window.confirm(`Удалить воркера «${worker.name}»? Его job'ы вернутся в очередь.`)) {
                        workerAction("deleteWorker", worker);
                      }
                    }}
                    disabled={busy}
                    className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50" style={{ borderColor: "#fca5a5", color: "#b91c1c" }}
                  >
                    Удалить
                  </button>
                )}
                {/* A revoked worker cannot be granted anything — its token is already dead. */}
                <select
                  value=""
                  disabled={busy || worker.status === "revoked"}
                  hidden={worker.status === "revoked"}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (!value) return;
                    const next =
                      value === "__all__"
                        ? []
                        : Array.from(new Set([...(worker.allowedProjectIds ?? []), value]));
                    workerAction("setWorkerProjects", worker, { allowedProjectIds: next });
                  }}
                  className="rounded border px-2 py-1 text-xs"
                >
                  <option value="">Доступ к проектам…</option>
                  <option value="__all__">Все проекты</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      + {project.name}
                    </option>
                  ))}
                </select>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-lg border p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Задачи</h2>
          <a href={`${(window as any).routePrefix ?? "/dashboard"}/agentiz-tasks`} className="text-xs underline">
            Открыть трекер задач
          </a>
        </div>
        {tasks.length === 0 && <p className="text-sm text-muted-foreground">Задач нет — запустите синхронизацию.</p>}
        <ul className="space-y-2">
          {tasks.map((task) => (
            <li key={task.id} className="rounded border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={task.status} />
                <span className="font-medium">
                  #{task.externalId} {task.title}
                </span>
                {/* Which task manager this task arrived from — a project can aggregate several. */}
                <span
                  className="rounded px-1.5 py-0.5 text-xs"
                  style={{ backgroundColor: "#eef2ff", color: "#4338ca" }}
                  title={task.sourceName ?? undefined}
                >
                  {task.sourceTitle ?? task.sourceType ?? "вручную"}
                </span>
                {(task.tags ?? []).map((tag) => (
                  <span key={tag} className="rounded px-1.5 py-0.5 text-xs" style={{ backgroundColor: "#f1f5f9", color: "#475569" }}>
                    {tag}
                  </span>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-3">
                <button
                  onClick={() => runTask(task.id)}
                  disabled={busy}
                  className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                >
                  Запустить пайплайн
                </button>
                <button
                  onClick={() => setSelectedTaskId(task.id)}
                  className="rounded border px-2 py-1 text-xs font-medium"
                >
                  Показать запуски
                </button>
                {task.externalUrl && (
                  <a href={task.externalUrl} target="_blank" rel="noreferrer" className="text-xs underline">
                    Открыть в трекере
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {selectedTaskId && (
        <div className="rounded-lg border p-4">
          <h2 className="mb-3 text-lg font-semibold">Запуски</h2>
          {runs.length === 0 && <p className="text-sm text-muted-foreground">У задачи ещё не было запусков.</p>}
          <ul className="space-y-2">
            {runs.map((run) => (
              <li key={run.id} className="rounded border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={run.status} />
                  <span className="text-xs text-muted-foreground">
                    {run.trigger} · {run.createdAt}
                  </span>
                </div>
                {run.resultSummary && (
                  <pre className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">{run.resultSummary}</pre>
                )}
                {run.errorMessage && <div className="mt-2 text-xs" style={{ color: "#dc2626" }}>{run.errorMessage}</div>}
                <div className="mt-2 flex gap-3 text-xs">
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
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default AgentizHome;
