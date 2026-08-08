import React, { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { PipelineHooksSection } from "./hooks/PipelineHooksSection";

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

/** A prepared directory on the worker's machine that a pipeline can run in. */
interface WorkerWorkspace {
  key: string;
  path: string;
  label?: string;
  description?: string;
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
  allowedRepositoryIds?: string[] | null;
  workspaces?: WorkerWorkspace[] | null;
}

/** Mirror of AgentRepository, only what the allowlist selector needs. */
interface RepositoryOption {
  id: string;
  provider: string;
  pathWithNamespace: string;
  connectionId: string;
}

/** What the agent changed in a run, as stored by AgentRunDiff. */
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

interface AgentRoleConfig {
  id: string;
  key: string;
  title: string;
  model?: string | null;
  config?: { executor?: string; provider?: string } | null;
}

interface PipelineStageConfig {
  order: number;
  role: string;
  agentRoleKey: string;
  onFail?: "stop" | "continue";
  runtime?: { mode?: "host" | "docker" };
}

interface PipelineSourceConfig {
  kind?: "repository" | "worker_workspace";
  workspace?: { workerId: string; workspaceKey: string };
  /** Which of the project's repositories this pipeline works on. Empty = the task's own. */
  repositoryId?: string;
}

/** A repository linked to the selected project, as the repositories screen returns it. */
interface ProjectRepositoryOption {
  id: string;
  repositoryId: string;
  role: string;
  repository: { id: string; provider: string; pathWithNamespace: string } | null;
}

/** One of the two scripts a pipeline can run around its stages. */
interface PipelineHookConfig {
  interpreter: "bash" | "node";
  script: string;
  timeoutSec?: number;
  onFail?: "stop" | "continue";
}

interface PipelineSpecConfig {
  id: string;
  name: string;
  isDefault: boolean;
  spec: {
    stages: PipelineStageConfig[];
    finalAction: Record<string, unknown>;
    triggers?: { humanComment?: boolean };
    source?: PipelineSourceConfig;
    hooks?: { before?: PipelineHookConfig; after?: PipelineHookConfig };
  };
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

function workerBuildLabel(version?: string | null): React.ReactNode {
  if (!version) return null;
  const match = version.match(/^agentiz-worker\/(.+)\+([0-9a-f]{7,}|unknown)$/i);
  if (!match) return <>версия: <code>{version}</code></>;
  return <>
    версия: <code>{match[1]}</code> · commit: <code>{match[2]}</code>
  </>;
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

const ISSUED_TOKEN_COLORS = {
  border: "#f59e0b",
  bg: "#fffbeb",
  fg: "#78350f",
  codeBorder: "#fcd34d",
  codeBg: "#ffffff",
  codeFg: "#111827",
  buttonBorder: "#d97706",
  buttonBg: "#fef3c7",
  buttonFg: "#78350f",
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

/**
 * Directories on the worker's own machine that pipelines may run in.
 *
 * The draft key/path live here rather than in the page so that typing into one worker's form does
 * not re-render every other worker card while a job list is refreshing.
 */
const WorkerWorkspacesEditor: React.FC<{
  worker: AgentWorker;
  busy: boolean;
  onSave: (workspaces: WorkerWorkspace[]) => void;
}> = ({ worker, busy, onSave }) => {
  const [key, setKey] = useState("");
  const [path, setPath] = useState("");
  const workspaces = worker.workspaces ?? [];

  const add = () => {
    const trimmedKey = key.trim();
    const trimmedPath = path.trim();
    if (!trimmedKey || !trimmedPath) return;
    onSave([...workspaces.filter((item) => item.key !== trimmedKey), { key: trimmedKey, path: trimmedPath }]);
    setKey("");
    setPath("");
  };

  return (
    <div className="mt-2 rounded border p-2">
      <div className="text-xs font-medium">Готовые папки для пайплайнов</div>
      {workspaces.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Пока нет. Укажите папку на машине воркера — пайплайн сможет работать прямо в ней, без репозитория.
        </p>
      ) : (
        <ul className="mt-1 space-y-1">
          {workspaces.map((workspace) => (
            <li key={workspace.key} className="flex flex-wrap items-center gap-2 text-xs">
              <code className="rounded border px-1">{workspace.key}</code>
              <span className="text-muted-foreground">{workspace.path}</span>
              <button
                onClick={() => onSave(workspaces.filter((item) => item.key !== workspace.key))}
                disabled={busy}
                className="rounded border px-1.5 py-0.5 disabled:opacity-50"
                style={{ borderColor: "#fca5a5", color: "#b91c1c" }}
              >
                Убрать
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder="ключ, напр. monorepo"
          className="rounded border px-2 py-1 text-xs"
        />
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="/home/dev/projects/monorepo"
          className="w-64 rounded border px-2 py-1 text-xs"
        />
        <button
          onClick={add}
          disabled={busy || !key.trim() || !path.trim()}
          className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
        >
          Добавить папку
        </button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Путь абсолютный и должен существовать на машине воркера: воркер работает в готовом окружении и сам его не создаёт.
        Ключ — то, на что ссылается пайплайн, поэтому менять путь можно, а ключ лучше сохранять.
      </p>
    </div>
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
  const [repositoryOptions, setRepositoryOptions] = useState<RepositoryOption[]>([]);
  const [projectRepositories, setProjectRepositories] = useState<ProjectRepositoryOption[]>([]);
  const [openDiffRunId, setOpenDiffRunId] = useState<string>("");
  const [runDiff, setRunDiff] = useState<RunDiff | null>(null);
  const [roles, setRoles] = useState<AgentRoleConfig[]>([]);
  const [pipelineSpecs, setPipelineSpecs] = useState<PipelineSpecConfig[]>([]);
  const [selectedPipelineSpecId, setSelectedPipelineSpecId] = useState("");
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

  /** Options for the worker repository allowlist; the shared repositories screen owns the rest. */
  const fetchRepositoryOptions = useCallback(async () => {
    try {
      const url = `${(window as any).routePrefix ?? "/dashboard"}/agentiz-repos`;
      const res = await axios.get(url, { params: { _method: "getRepositories" } });
      setRepositoryOptions(res.data?.data ?? []);
    } catch {
      // Not fatal: the allowlist selector simply stays empty.
      setRepositoryOptions([]);
    }
  }, []);

  /** Repositories the selected project may work with — the pipeline can only pick among these. */
  const fetchProjectRepositories = useCallback(async (projectId: string) => {
    if (!projectId) {
      setProjectRepositories([]);
      return;
    }
    try {
      const url = `${(window as any).routePrefix ?? "/dashboard"}/agentiz-repos`;
      const res = await axios.get(url, { params: { _method: "getProjectRepositories", projectId } });
      setProjectRepositories(res.data?.data ?? []);
    } catch {
      setProjectRepositories([]);
    }
  }, []);

  const openDiff = useCallback(async (runId: string) => {
    if (openDiffRunId === runId) {
      setOpenDiffRunId("");
      setRunDiff(null);
      return;
    }
    try {
      const res = await axios.get(API_URL, { params: { _method: "getRunDetails", runId } });
      setRunDiff(res.data?.data?.diff ?? null);
      setOpenDiffRunId(runId);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Не удалось загрузить дифф запуска");
    }
  }, [openDiffRunId]);

  const applyRunDiff = useCallback(async (runId: string) => {
    if (!window.confirm("Применить изменения в репозиторий? Повторно это сделать нельзя.")) return;
    setBusy(true);
    setError(null);
    try {
      await axios.post(API_URL, { _method: "applyRunDiff", runId });
      await fetchRuns(selectedTaskId);
      const res = await axios.get(API_URL, { params: { _method: "getRunDetails", runId } });
      setRunDiff(res.data?.data?.diff ?? null);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Не удалось применить изменения");
    } finally {
      setBusy(false);
    }
  }, [fetchRuns, selectedTaskId]);

  const fetchPipelineConfiguration = useCallback(async (projectId: string) => {
    if (!projectId) {
      setRoles([]);
      setPipelineSpecs([]);
      return;
    }
    try {
      const res = await axios.get(API_URL, { params: { _method: "getPipelineConfiguration", projectId } });
      const data = res.data?.data ?? {};
      const specs: PipelineSpecConfig[] = data.specs ?? [];
      setRoles(data.roles ?? []);
      setPipelineSpecs(specs);
      setSelectedPipelineSpecId((current) => current || specs.find((spec) => spec.isDefault)?.id || specs[0]?.id || "");
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Не удалось загрузить настройки пайплайна");
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
    fetchRepositoryOptions();
  }, [fetchProjects, fetchWorkers, fetchRepositoryOptions]);

  useEffect(() => {
    fetchTasks(selectedProjectId);
    fetchPipelineConfiguration(selectedProjectId);
    fetchProjectRepositories(selectedProjectId);
    setSelectedTaskId("");
    setRuns([]);
  }, [selectedProjectId, fetchTasks, fetchPipelineConfiguration, fetchProjectRepositories]);

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

  const setRoleProvider = useCallback(async (roleId: string, provider: "codex" | "claude") => {
    setBusy(true);
    setError(null);
    try {
      await axios.post(API_URL, { _method: "setRoleAcpProvider", roleId, provider });
      await fetchPipelineConfiguration(selectedProjectId);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Не удалось настроить ACP-агента");
    } finally {
      setBusy(false);
    }
  }, [fetchPipelineConfiguration, selectedProjectId]);

  /**
   * The spec is stored as one document, so every editor on this page writes the whole thing.
   * `failure` names the edit rather than the endpoint: "не удалось сохранить стадию" is what the
   * person was actually doing.
   */
  const savePipelineSpec = useCallback(async (
    build: (current: PipelineSpecConfig["spec"]) => PipelineSpecConfig["spec"],
    failure: string,
  ) => {
    const pipelineSpec = pipelineSpecs.find((spec) => spec.id === selectedPipelineSpecId);
    if (!pipelineSpec) return;
    setBusy(true);
    setError(null);
    try {
      await axios.post(API_URL, { _method: "updatePipelineSpec", specId: pipelineSpec.id, spec: build(pipelineSpec.spec) });
      await fetchPipelineConfiguration(selectedProjectId);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? failure);
    } finally {
      setBusy(false);
    }
  }, [fetchPipelineConfiguration, pipelineSpecs, selectedPipelineSpecId, selectedProjectId]);

  const saveStage = useCallback((stageIndex: number, patch: Partial<PipelineStageConfig>) => {
    void savePipelineSpec((current) => ({
      ...current,
      stages: current.stages.map((stage, index) => index === stageIndex ? { ...stage, ...patch } : stage),
    }), "Не удалось сохранить стадию пайплайна");
  }, [savePipelineSpec]);

  const setHumanCommentTrigger = useCallback((enabled: boolean) => {
    void savePipelineSpec((current) => ({
      ...current,
      triggers: { ...current.triggers, humanComment: enabled },
    }), "Не удалось сохранить триггер пайплайна");
  }, [savePipelineSpec]);

  /**
   * Switches the pipeline between "работать с репозиторием проекта" and "работать в готовой папке
   * на воркере". A worker directory has nothing to push to, so a pipeline that used to open a PR is
   * moved to a comment — the server rejects the combination outright, and silently failing every
   * later run would be worse than saying so here.
   */
  /** Keeps the rest of `source` intact: kind, workspace and branch are edited separately. */
  const setPipelineRepository = useCallback((repositoryId: string) => {
    void savePipelineSpec((current) => ({
      ...current,
      source: { ...(current.source ?? {}), kind: "repository", repositoryId: repositoryId || undefined },
    }), "Не удалось сохранить репозиторий пайплайна");
  }, [savePipelineSpec]);

  /**
   * Stores both hooks as one object. A position set to `undefined` is dropped rather than saved as
   * null, so a spec that never had hooks stays byte-identical to what it was.
   */
  const setPipelineHooks = useCallback((hooks: { before?: PipelineHookConfig; after?: PipelineHookConfig }) => {
    void savePipelineSpec((current) => {
      const next: Record<string, PipelineHookConfig> = {};
      if (hooks.before) next.before = hooks.before;
      if (hooks.after) next.after = hooks.after;
      const { hooks: _dropped, ...rest } = current;
      return Object.keys(next).length ? { ...rest, hooks: next } : rest;
    }, "Не удалось сохранить скрипт пайплайна");
  }, [savePipelineSpec]);

  const setPipelineSource = useCallback((source: PipelineSourceConfig) => {
    void savePipelineSpec((current) => {
      const finalAction = source.kind === "worker_workspace" && current.finalAction?.type === "commit_and_pr"
        ? { ...current.finalAction, type: "comment_only" }
        : current.finalAction;
      return { ...current, source, finalAction };
    }, "Не удалось сохранить источник пайплайна");
  }, [savePipelineSpec]);

  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const selectedPipelineSpec = pipelineSpecs.find((spec) => spec.id === selectedPipelineSpecId);
  const pipelineSource = selectedPipelineSpec?.spec.source;
  const pipelineSourceKind = pipelineSource?.kind === "worker_workspace" ? "worker_workspace" : "repository";
  /** Only a worker that actually declares directories can host such a pipeline. */
  const workspaceWorkers = workers.filter((worker) => worker.status !== "revoked" && (worker.workspaces?.length ?? 0) > 0);
  const sourceWorker = workers.find((worker) => worker.id === pipelineSource?.workspace?.workerId);

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
          <div>
            <h2 className="text-lg font-semibold">ACP-агенты и пайплайн</h2>
            <p className="text-xs text-muted-foreground">Сначала выберите Codex или Claude для роли, затем назначьте роль и workspace каждой стадии.</p>
          </div>
          {pipelineSpecs.length > 0 && (
            <select
              value={selectedPipelineSpecId}
              onChange={(event) => setSelectedPipelineSpecId(event.target.value)}
              className="rounded border px-2 py-1 text-sm"
            >
              {pipelineSpecs.map((spec) => <option key={spec.id} value={spec.id}>{spec.name}{spec.isDefault ? " · default" : ""}</option>)}
            </select>
          )}
        </div>

        {roles.length === 0 ? <p className="text-sm text-muted-foreground">Выберите проект с ролями.</p> : (
          <div className="space-y-2">
            {roles.map((role) => (
              <div key={role.id} className="flex flex-wrap items-center justify-between gap-3 rounded border p-2 text-sm">
                <div><span className="font-medium">{role.title}</span><span className="ml-2 text-xs text-muted-foreground">{role.key}</span></div>
                <select
                  value={role.config?.provider === "claude" ? "claude" : role.config?.provider === "codex" ? "codex" : ""}
                  onChange={(event) => event.target.value && setRoleProvider(role.id, event.target.value as "codex" | "claude")}
                  disabled={busy}
                  className="rounded border px-2 py-1 text-sm disabled:opacity-50"
                >
                  <option value="">Выберите ACP-агента</option>
                  <option value="codex">Codex · ChatGPT subscription</option>
                  <option value="claude">Claude · subscription</option>
                </select>
              </div>
            ))}
          </div>
        )}

        {selectedPipelineSpec && (
          <div className="mt-4 space-y-2">
            <div className="rounded border p-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">С чем работает пайплайн</span>
                <select
                  value={pipelineSourceKind}
                  onChange={(event) => {
                    if (event.target.value === "repository") {
                      setPipelineSource({ kind: "repository" });
                      return;
                    }
                    const worker = sourceWorker ?? workspaceWorkers[0];
                    const workspace = worker?.workspaces?.[0];
                    if (!worker || !workspace) return;
                    setPipelineSource({ kind: "worker_workspace", workspace: { workerId: worker.id, workspaceKey: workspace.key } });
                  }}
                  disabled={busy || (pipelineSourceKind === "repository" && workspaceWorkers.length === 0)}
                  className="rounded border px-2 py-1 disabled:opacity-50"
                >
                  <option value="repository">Репозиторий проекта (GitHub/GitLab)</option>
                  <option value="worker_workspace">Готовая папка на воркере</option>
                </select>

                {pipelineSourceKind === "repository" && (
                  <select
                    value={pipelineSource?.repositoryId ?? ""}
                    onChange={(event) => setPipelineRepository(event.target.value)}
                    disabled={busy}
                    className="rounded border px-2 py-1 disabled:opacity-50"
                  >
                    <option value="">Репозиторий задачи</option>
                    {projectRepositories.map((link) => (
                      <option key={link.id} value={link.repositoryId}>
                        {link.repository?.pathWithNamespace ?? link.repositoryId}
                      </option>
                    ))}
                  </select>
                )}

                {pipelineSourceKind === "worker_workspace" && (
                  <>
                    <select
                      value={pipelineSource?.workspace?.workerId ?? ""}
                      onChange={(event) => {
                        const worker = workspaceWorkers.find((item) => item.id === event.target.value);
                        const workspace = worker?.workspaces?.[0];
                        if (!worker || !workspace) return;
                        setPipelineSource({ kind: "worker_workspace", workspace: { workerId: worker.id, workspaceKey: workspace.key } });
                      }}
                      disabled={busy}
                      className="rounded border px-2 py-1 disabled:opacity-50"
                    >
                      {workspaceWorkers.map((worker) => <option key={worker.id} value={worker.id}>{worker.name}</option>)}
                      {sourceWorker && !workspaceWorkers.some((worker) => worker.id === sourceWorker.id) && (
                        <option value={sourceWorker.id}>{sourceWorker.name} (папок нет)</option>
                      )}
                    </select>
                    <select
                      value={pipelineSource?.workspace?.workspaceKey ?? ""}
                      onChange={(event) => {
                        const workerId = pipelineSource?.workspace?.workerId;
                        if (!workerId) return;
                        setPipelineSource({ kind: "worker_workspace", workspace: { workerId, workspaceKey: event.target.value } });
                      }}
                      disabled={busy || !sourceWorker}
                      className="rounded border px-2 py-1 disabled:opacity-50"
                    >
                      {(sourceWorker?.workspaces ?? []).map((workspace) => (
                        <option key={workspace.key} value={workspace.key}>{workspace.label ?? workspace.key}</option>
                      ))}
                    </select>
                  </>
                )}
              </div>

              {pipelineSourceKind === "worker_workspace" ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Запуски этого пайплайна уходят только на выбранного воркера и выполняются прямо в{" "}
                  <code>{sourceWorker?.workspaces?.find((item) => item.key === pipelineSource?.workspace?.workspaceKey)?.path ?? "—"}</code>.
                  Репозиторий не нужен, коммит и PR недоступны, стадии выполняются в режиме Host.
                </p>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  {pipelineSource?.repositoryId
                    ? "Код берётся из выбранного репозитория и коммит уезжает обратно в него же. Комментарий по задаче уходит туда, где задача живёт."
                    : "Код берётся из репозитория, из которого пришла задача, и коммит уезжает туда же."}
                  {projectRepositories.length === 0 && " Репозитории проекта настраиваются на экране «Репозитории»."}
                  {workspaceWorkers.length === 0 && " Готовых папок ни у одного воркера пока не объявлено."}
                </p>
              )}
            </div>

            <label className="flex items-center gap-2 rounded border p-2 text-sm">
              <input
                type="checkbox"
                checked={selectedPipelineSpec.spec.triggers?.humanComment === true}
                onChange={(event) => setHumanCommentTrigger(event.target.checked)}
                disabled={busy}
              />
              Запускать пайплайн после нового сообщения пользователя
            </label>
            <p className="text-xs text-muted-foreground">Сообщение становится основным промтом; весь тред и результаты прошлых запусков передаются как контекст.</p>

            <PipelineHooksSection
              hooks={selectedPipelineSpec.spec.hooks}
              sourceKind={pipelineSourceKind}
              busy={busy}
              onSave={setPipelineHooks}
            />

            <h3 className="text-sm font-medium">Стадии</h3>
            {selectedPipelineSpec.spec.stages.map((stage, index) => (
              <div key={`${stage.order}-${stage.role}`} className="flex flex-wrap items-center gap-2 rounded border p-2 text-sm">
                <span className="w-16 text-xs text-muted-foreground">#{stage.order} {stage.role}</span>
                <select
                  value={stage.agentRoleKey}
                  onChange={(event) => saveStage(index, { agentRoleKey: event.target.value })}
                  disabled={busy}
                  className="rounded border px-2 py-1 disabled:opacity-50"
                >
                  {roles.map((role) => <option key={role.id} value={role.key}>{role.title} ({role.key})</option>)}
                </select>
                <select
                  value={stage.runtime?.mode ?? ""}
                  onChange={(event) => saveStage(index, { runtime: { mode: event.target.value as "host" | "docker" } })}
                  disabled={busy}
                  className="rounded border px-2 py-1 disabled:opacity-50"
                >
                  <option value="" disabled>Workspace</option>
                  <option value="host">Host</option>
                  {/* A container has its own filesystem, so it cannot see the worker's directory. */}
                  <option value="docker" disabled={pipelineSourceKind === "worker_workspace"}>Docker</option>
                </select>
              </div>
            ))}
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
          <div
            className="mb-3 rounded border p-3 text-sm"
            style={{ borderColor: ISSUED_TOKEN_COLORS.border, backgroundColor: ISSUED_TOKEN_COLORS.bg, color: ISSUED_TOKEN_COLORS.fg }}
          >
            <div className="font-medium">
              Токен воркера «{issuedToken.workerName}» — показывается один раз
            </div>
            <code
              className="mt-1 block break-all rounded border px-2 py-1 text-xs"
              style={{
                borderColor: ISSUED_TOKEN_COLORS.codeBorder,
                backgroundColor: ISSUED_TOKEN_COLORS.codeBg,
                color: ISSUED_TOKEN_COLORS.codeFg,
              }}
            >
              {issuedToken.token}
            </code>
            <div className="mt-2 text-xs">
              Как установить воркер:{" "}
              <a
                href="https://docs.agentiz.m42.cx/worker-install"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                docs.agentiz.m42.cx/worker-install
              </a>
            </div>
            <div className="mt-2 text-xs">На машине воркера запустите настройку, выберите сервер и вставьте этот токен:</div>
            <code
              className="mt-1 block break-all rounded border px-2 py-1 text-xs"
              style={{
                borderColor: ISSUED_TOKEN_COLORS.codeBorder,
                backgroundColor: ISSUED_TOKEN_COLORS.codeBg,
                color: ISSUED_TOKEN_COLORS.codeFg,
              }}
            >
              {`agentiz-worker configure  # сервер: ${issuedToken.workerApiUrl}`}
            </code>
            <button
              onClick={() => setIssuedToken(null)}
              className="mt-2 rounded border px-2 py-1 text-xs"
              style={{
                borderColor: ISSUED_TOKEN_COLORS.buttonBorder,
                backgroundColor: ISSUED_TOKEN_COLORS.buttonBg,
                color: ISSUED_TOKEN_COLORS.buttonFg,
              }}
            >
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
                {" · репозитории: "}
                {worker.allowedRepositoryIds?.length
                  ? worker.allowedRepositoryIds
                      .map((id) => repositoryOptions.find((r) => r.id === id)?.pathWithNamespace ?? id)
                      .join(", ")
                  : "все разрешённых проектов"}
              </div>
              {worker.version && (
                <div className="mt-1 text-xs text-muted-foreground">
                  {workerBuildLabel(worker.version)}
                </div>
              )}
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
                <select
                  value=""
                  disabled={busy || worker.status === "revoked" || repositoryOptions.length === 0}
                  hidden={worker.status === "revoked"}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (!value) return;
                    const next =
                      value === "__all__"
                        ? []
                        : Array.from(new Set([...(worker.allowedRepositoryIds ?? []), value]));
                    workerAction("setWorkerRepositories", worker, { allowedRepositoryIds: next });
                  }}
                  className="rounded border px-2 py-1 text-xs"
                >
                  <option value="">Доступ к репозиториям…</option>
                  <option value="__all__">Все репозитории</option>
                  {repositoryOptions.map((repository) => (
                    <option key={repository.id} value={repository.id}>
                      + {repository.pathWithNamespace}
                    </option>
                  ))}
                </select>
              </div>
              {worker.status !== "revoked" && (
                <WorkerWorkspacesEditor
                  worker={worker}
                  busy={busy}
                  onSave={(workspaces) => workerAction("setWorkerWorkspaces", worker, { workspaces })}
                />
              )}
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
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
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
                  <button onClick={() => openDiff(run.id)} className="underline">
                    {openDiffRunId === run.id ? "Скрыть дифф" : "Дифф"}
                  </button>
                </div>

                {openDiffRunId === run.id && (
                  <div className="mt-2 rounded border p-2">
                    {!runDiff ? (
                      <p className="text-xs text-muted-foreground">Этот запуск ничего не менял в коде.</p>
                    ) : (
                      <>
                        <div className="text-xs text-muted-foreground">
                          от <code>{(runDiff.baseSha ?? "—").slice(0, 12)}</code>
                          {" · "}
                          {runDiff.stats?.files ?? runDiff.ops?.length ?? 0} файл(ов),{" "}
                          +{runDiff.stats?.insertions ?? 0} −{runDiff.stats?.deletions ?? 0}
                          {runDiff.appliedAt
                            ? ` · применено ${new Date(runDiff.appliedAt).toLocaleString()}, коммит ${(runDiff.appliedCommitSha ?? "").slice(0, 12)}`
                            : " · в репозиторий не отправлено"}
                        </div>
                        <ul className="mt-2 space-y-0.5 text-xs">
                          {(runDiff.ops ?? []).map((op, index) => (
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
                        {runDiff.truncated && (
                          <div className="mt-2 text-xs" style={{ color: "#b45309" }}>
                            Патч обрезан по лимиту размера. Операции сохранены полностью — применяются именно они.
                          </div>
                        )}
                        {runDiff.patch && (
                          <pre className="mt-2 max-h-96 overflow-auto rounded border p-2 text-xs" style={{ backgroundColor: "#f8fafc" }}>
                            {runDiff.patch}
                          </pre>
                        )}
                        {/* Only offered while the change is still held: applying twice is refused
                            by the server, and a button that always fails is worse than no button. */}
                        {!runDiff.appliedAt && (runDiff.ops?.length ?? 0) > 0 && (
                          <button
                            onClick={() => applyRunDiff(run.id)}
                            disabled={busy}
                            className="mt-2 rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                          >
                            Применить в репозиторий
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default AgentizHome;
