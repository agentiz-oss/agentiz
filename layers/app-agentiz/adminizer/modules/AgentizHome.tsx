import React, { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { formatDateTime, useViewerTimezone } from "./lib/viewerTime";

/**
 * The project overview: pick a project, see how it's doing at a glance, then go to the screen
 * that actually manages the thing you clicked on. Tasks, pipelines, workers and repositories each
 * live on their own page now — see AgentizTasks.tsx, AgentizPipelines.tsx, AgentizWorkers.tsx and
 * AgentizRepositories.tsx. This page only orients.
 */
interface AgentProject {
  id: string;
  name: string;
  slug: string;
  repoProvider: string;
  repoConfig?: { owner?: string; repo?: string };
  isActive: boolean;
  lastSyncedAt?: string | null;
}

interface AgentRun {
  id: string;
  status: string;
  trigger: string;
  createdAt?: string;
}

interface ProjectStats {
  tasksByStatus: Record<string, number>;
  runsByStatus: Record<string, number>;
  pipelineCount: number;
  workers: { total: number; online: number };
  recentRuns: AgentRun[];
}

const PREFIX = (window as any).routePrefix ?? "/dashboard";
const API_URL = `${PREFIX}/agentiz`;

/**
 * Inline styles rather than Tailwind palette classes: Adminizer serves a prebuilt, restricted
 * Tailwind bundle in which `bg-emerald-100` / `text-red-700` and friends do not exist, so a
 * class-based palette renders as flat grey. Layout utilities are present and still used.
 */
const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  new: { bg: "#f1f5f9", fg: "#334155" },
  queued: { bg: "#dbeafe", fg: "#1d4ed8" },
  running: { bg: "#fef3c7", fg: "#b45309" },
  pending: { bg: "#fef3c7", fg: "#b45309" },
  waiting_review: { bg: "#ede9fe", fg: "#6d28d9" },
  done: { bg: "#d1fae5", fg: "#047857" },
  succeeded: { bg: "#d1fae5", fg: "#047857" },
  failed: { bg: "#fee2e2", fg: "#b91c1c" },
  cancelled: { bg: "#f1f5f9", fg: "#64748b" },
  ignored: { bg: "#f1f5f9", fg: "#64748b" },
};

const TASK_STATUS_TITLES: Record<string, string> = {
  new: "новые", queued: "в очереди", running: "выполняются", waiting_review: "на проверке",
  done: "готовы", failed: "провалены", cancelled: "отменены", ignored: "проигнорированы",
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const swatch = STATUS_COLORS[status] ?? { bg: "#f1f5f9", fg: "#334155" };
  return (
    <span className="inline-block rounded px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: swatch.bg, color: swatch.fg }}>
      {status}
    </span>
  );
};

/** One number, one label — the building block of the stats row up top. */
const StatTile: React.FC<{ label: string; value: React.ReactNode; hint?: string }> = ({ label, value, hint }) => (
  <div className="rounded-lg border p-4">
    <div className="text-2xl font-bold tracking-tight">{value}</div>
    <div className="text-xs text-muted-foreground">{label}</div>
    {hint && <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>}
  </div>
);

/** A link tile into one of the split-out screens, scoped to the current project. */
const NavCard: React.FC<{ title: string; description: string; href: string }> = ({ title, description, href }) => (
  <a href={href} className="block rounded-lg border p-4 hover:bg-primary/5">
    <div className="text-base font-semibold">{title} →</div>
    <div className="mt-1 text-xs text-muted-foreground">{description}</div>
  </a>
);

const AgentizHome: React.FC = () => {
  useViewerTimezone();
  const [projects, setProjects] = useState<AgentProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [stats, setStats] = useState<ProjectStats | null>(null);
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

  const fetchStats = useCallback(async (projectId: string) => {
    if (!projectId) {
      setStats(null);
      return;
    }
    try {
      const res = await axios.get(API_URL, { params: { _method: "getProjectStats", projectId } });
      setStats(res.data?.data ?? null);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Не удалось загрузить статистику проекта");
    }
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  useEffect(() => {
    fetchStats(selectedProjectId);
  }, [selectedProjectId, fetchStats]);

  const syncProject = useCallback(async () => {
    if (!selectedProjectId) return;
    setBusy(true);
    setError(null);
    try {
      await axios.post(API_URL, { _method: "syncProject", projectId: selectedProjectId });
      await Promise.all([fetchStats(selectedProjectId), fetchProjects()]);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Синхронизация не удалась");
    } finally {
      setBusy(false);
    }
  }, [selectedProjectId, fetchStats, fetchProjects]);

  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const openTasks = stats
    ? Object.entries(stats.tasksByStatus).filter(([status]) => !["done", "cancelled", "ignored", "failed"].includes(status))
        .reduce((sum, [, count]) => sum + count, 0)
    : 0;
  const totalRuns = stats ? Object.values(stats.runsByStatus).reduce((sum, count) => sum + count, 0) : 0;
  const failedRuns = stats?.runsByStatus.failed ?? 0;
  const withProject = (path: string) => `${PREFIX}${path}${selectedProjectId ? `?projectId=${selectedProjectId}` : ""}`;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Agentiz</h1>
        <p className="text-sm text-muted-foreground">
          Проекты и сводка по каждому. Задачи, пайплайны, воркеры и репозитории — на своих страницах.
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

      {selectedProject && (
        <>
          <div>
            <h2 className="mb-3 text-lg font-semibold">{selectedProject.name}</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile label="открытых задач" value={openTasks} hint={Object.keys(stats?.tasksByStatus ?? {}).length === 0 ? "задач нет" : undefined} />
              <StatTile label="воркеров на связи" value={`${stats?.workers.online ?? 0} / ${stats?.workers.total ?? 0}`} />
              <StatTile label="запусков всего" value={totalRuns} hint={failedRuns > 0 ? `провалено: ${failedRuns}` : undefined} />
              <StatTile label="пайплайнов" value={stats?.pipelineCount ?? 0} />
            </div>
          </div>

          {stats && Object.keys(stats.tasksByStatus).length > 0 && (
            <div className="rounded-lg border p-4">
              <h3 className="mb-2 text-sm font-semibold text-muted-foreground">Задачи по статусу</h3>
              <div className="flex flex-wrap gap-2">
                {Object.entries(stats.tasksByStatus).map(([status, count]) => (
                  <span key={status} className="flex items-center gap-1.5 rounded border px-2 py-1 text-sm">
                    <StatusBadge status={status} /> {TASK_STATUS_TITLES[status] ?? status}: <b>{count}</b>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <NavCard title="Задачи" description="Трекер: задачи из внешних систем и запуски по ним" href={withProject("/agentiz-tasks")} />
            <NavCard title="Пайплайны" description="ACP-агенты, стадии, источник и хуки" href={withProject("/agentiz-pipelines")} />
            <NavCard title="Воркеры" description="Регистрация машин и доступы" href={`${PREFIX}/agentiz-workers`} />
            <NavCard title="Репозитории" description="Подключения и привязка к проекту" href={withProject("/agentiz-repos")} />
          </div>

          {stats && stats.recentRuns.length > 0 && (
            <div className="rounded-lg border p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-muted-foreground">Последние запуски</h3>
                <a href={withProject("/agentiz-tasks")} className="text-xs underline">Все задачи и запуски →</a>
              </div>
              <ul className="space-y-1">
                {stats.recentRuns.map((run) => (
                  <li key={run.id}>
                    <a href={`${PREFIX}/agentiz-runs?runId=${run.id}`} className="flex flex-wrap items-center gap-2 rounded border p-2 text-sm hover:bg-primary/5">
                      <StatusBadge status={run.status} />
                      <span className="text-xs text-muted-foreground">{run.trigger} · {formatDateTime(run.createdAt)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default AgentizHome;
