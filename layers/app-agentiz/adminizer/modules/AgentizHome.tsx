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

const API_URL = `${(window as any).routePrefix ?? "/dashboard"}/agentiz`;

const STATUS_COLORS: Record<string, string> = {
  new: "bg-slate-100 text-slate-700",
  queued: "bg-blue-100 text-blue-700",
  running: "bg-amber-100 text-amber-700",
  waiting_review: "bg-violet-100 text-violet-700",
  done: "bg-emerald-100 text-emerald-700",
  succeeded: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-slate-100 text-slate-500",
  ignored: "bg-slate-100 text-slate-500",
  pending: "bg-slate-100 text-slate-700",
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => (
  <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[status] ?? "bg-slate-100 text-slate-700"}`}>
    {status}
  </span>
);

const AgentizHome: React.FC = () => {
  const [projects, setProjects] = useState<AgentProject[]>([]);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");
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

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

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

      {error && <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

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
        <h2 className="mb-3 text-lg font-semibold">Задачи</h2>
        {tasks.length === 0 && <p className="text-sm text-muted-foreground">Задач нет — запустите синхронизацию.</p>}
        <ul className="space-y-2">
          {tasks.map((task) => (
            <li key={task.id} className="rounded border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={task.status} />
                <span className="font-medium">
                  #{task.externalId} {task.title}
                </span>
                {(task.tags ?? []).map((tag) => (
                  <span key={tag} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
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
                {run.errorMessage && <div className="mt-2 text-xs text-red-600">{run.errorMessage}</div>}
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
