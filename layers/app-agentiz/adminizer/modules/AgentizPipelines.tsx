import React, { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { PipelineHooksSection } from "./hooks/PipelineHooksSection";

/**
 * ACP-agent assignment and pipeline-spec editing for one project. Split out of the project
 * overview: picking a role's agent, wiring stages and choosing what a pipeline runs against is a
 * whole workflow of its own, not a block to scroll past.
 */
interface AgentProject {
  id: string;
  name: string;
  slug: string;
}

interface WorkerWorkspace {
  key: string;
  path: string;
  label?: string;
  description?: string;
  git?: { pushEnabled: boolean; remote?: string };
}

interface AgentWorker {
  id: string;
  name: string;
  status: string;
  workspaces?: WorkerWorkspace[] | null;
}

interface ProjectRepositoryOption {
  id: string;
  repositoryId: string;
  role: string;
  repository: { id: string; provider: string; pathWithNamespace: string } | null;
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
  /** Overrides the role's own model for this stage only. Absent = the role's model. */
  model?: string | null;
  onFail?: "stop" | "continue";
  runtime?: { mode?: "host" | "docker" };
}

interface PipelineSourceConfig {
  kind?: "repository" | "worker_workspace";
  workspace?: { workerId: string; workspaceKey?: string; path?: string; createIfMissing?: boolean };
  repositoryId?: string;
}

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
    finalAction: {
      type: "commit_and_pr" | "commit" | "comment_only" | "none";
      requireApproval?: boolean;
      targetBranch?: { mode: "current" | "new"; prefix?: string };
      commitMessageTemplate?: string;
      [key: string]: unknown;
    };
    triggers?: { humanComment?: boolean };
    source?: PipelineSourceConfig;
    hooks?: { before?: PipelineHookConfig; after?: PipelineHookConfig };
  };
}

const PREFIX = (window as any).routePrefix ?? "/dashboard";
const HOME_URL = `${PREFIX}/agentiz`;
const REPOS_URL = `${PREFIX}/agentiz-repos`;
const WORKERS_URL = `${PREFIX}/agentiz-workers`;
const API_URL = `${PREFIX}/agentiz-pipelines`;

/**
 * The path a `worker_workspace` pipeline names directly, instead of a key declared on the worker.
 * Kept as an uncontrolled draft with an explicit save so typing a path does not fire a spec save
 * (and a validation round trip) on every keystroke.
 */
const PipelineWorkspacePathEditor: React.FC<{
  workerId: string;
  savedPath: string;
  savedCreateIfMissing: boolean;
  busy: boolean;
  onSave: (path: string, createIfMissing: boolean) => void;
}> = ({ workerId, savedPath, savedCreateIfMissing, busy, onSave }) => {
  const [path, setPath] = useState(savedPath);
  const [createIfMissing, setCreateIfMissing] = useState(savedCreateIfMissing);

  // The spec is the source of truth: switching to a different worker or spec should replace the
  // draft, not merge with whatever was half-typed for the previous one.
  useEffect(() => {
    setPath(savedPath);
    setCreateIfMissing(savedCreateIfMissing);
  }, [workerId, savedPath, savedCreateIfMissing]);

  const dirty = path.trim() !== savedPath || createIfMissing !== savedCreateIfMissing;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <input
        value={path}
        onChange={(event) => setPath(event.target.value)}
        placeholder="/prj/lyapka-rf"
        className="w-64 rounded border px-2 py-1 text-xs"
      />
      <label className="flex items-center gap-1 text-xs">
        <input
          type="checkbox"
          checked={createIfMissing}
          onChange={(event) => setCreateIfMissing(event.target.checked)}
        />
        Создать, если её нет
      </label>
      <button
        onClick={() => onSave(path.trim(), createIfMissing)}
        disabled={busy || !path.trim() || !dirty}
        className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
      >
        Сохранить путь
      </button>
    </div>
  );
};

/** Project switcher — a lightweight, page-local copy of the same picker every screen needs. */
const ProjectPicker: React.FC<{
  projects: AgentProject[];
  selectedProjectId: string;
  onSelect: (id: string) => void;
}> = ({ projects, selectedProjectId, onSelect }) => (
  <select
    value={selectedProjectId}
    onChange={(event) => onSelect(event.target.value)}
    className="rounded border px-2 py-1.5 text-sm"
  >
    {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
  </select>
);

const AgentizPipelines: React.FC = () => {
  const [projects, setProjects] = useState<AgentProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [projectRepositories, setProjectRepositories] = useState<ProjectRepositoryOption[]>([]);
  const [workers, setWorkers] = useState<AgentWorker[]>([]);
  const [roles, setRoles] = useState<AgentRoleConfig[]>([]);
  const [pipelineSpecs, setPipelineSpecs] = useState<PipelineSpecConfig[]>([]);
  const [selectedPipelineSpecId, setSelectedPipelineSpecId] = useState("");
  const [workspaceNameMode, setWorkspaceNameMode] = useState<"key" | "path">("key");
  const [pendingWorkerWorkspace, setPendingWorkerWorkspace] = useState(false);
  const [pendingWorkerId, setPendingWorkerId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const preset = new URLSearchParams(window.location.search).get("projectId");
    if (preset) setSelectedProjectId(preset);
  }, []);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await axios.get(HOME_URL, { params: { _method: "getProjects" } });
      const items: AgentProject[] = res.data?.data ?? [];
      setProjects(items);
      if (items.length > 0) setSelectedProjectId((current) => current || items[0].id);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Не удалось загрузить проекты");
    }
  }, []);

  const fetchProjectRepositories = useCallback(async (projectId: string) => {
    if (!projectId) {
      setProjectRepositories([]);
      return;
    }
    try {
      const res = await axios.get(REPOS_URL, { params: { _method: "getProjectRepositories", projectId } });
      setProjectRepositories(res.data?.data ?? []);
    } catch {
      setProjectRepositories([]);
    }
  }, []);

  const fetchWorkers = useCallback(async () => {
    try {
      const res = await axios.get(WORKERS_URL, { params: { _method: "getWorkers" } });
      setWorkers(res.data?.data ?? []);
    } catch {
      setWorkers([]);
    }
  }, []);

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

  useEffect(() => {
    fetchProjects();
    fetchWorkers();
  }, [fetchProjects, fetchWorkers]);

  useEffect(() => {
    fetchPipelineConfiguration(selectedProjectId);
    fetchProjectRepositories(selectedProjectId);
    setSelectedPipelineSpecId("");
  }, [selectedProjectId, fetchPipelineConfiguration, fetchProjectRepositories]);

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
      const finalAction = source.kind === "worker_workspace" && (current.finalAction?.type === "commit_and_pr" || current.finalAction?.type === "commit")
        ? { ...current.finalAction, type: "comment_only" as const }
        : current.finalAction;
      return { ...current, source, finalAction };
    }, "Не удалось сохранить источник пайплайна");
  }, [savePipelineSpec]);

  const setWorkspaceDelivery = useCallback((type: "commit" | "comment_only" | "none") => {
    void savePipelineSpec((current) => {
      if (type !== "commit") return { ...current, finalAction: { type } };
      const workspace = current.source?.workspace;
      const worker = workers.find((item) => item.id === workspace?.workerId);
      const declared = worker?.workspaces?.find((item) => item.key === workspace?.workspaceKey);
      const repositoryId = current.source?.repositoryId || projectRepositories[0]?.repositoryId;
      if (!workspace?.workspaceKey || !declared?.git?.pushEnabled || !repositoryId) return current;
      return {
        ...current,
        source: { ...current.source, kind: "worker_workspace", repositoryId },
        finalAction: {
          type: "commit", requireApproval: true,
          targetBranch: { mode: "new", prefix: "agentiz/" },
          commitMessageTemplate: "{{title}}\n\n{{summary}}",
        },
      };
    }, "Не удалось включить Git-доставку workspace");
  }, [projectRepositories, savePipelineSpec, workers]);

  const patchWorkspaceFinalAction = useCallback((patch: Record<string, unknown>) => {
    void savePipelineSpec((current) => ({ ...current, finalAction: { ...current.finalAction, ...patch } }),
      "Не удалось сохранить Git-доставку workspace");
  }, [savePipelineSpec]);

  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const selectedPipelineSpec = pipelineSpecs.find((spec) => spec.id === selectedPipelineSpecId);
  const pipelineSource = selectedPipelineSpec?.spec.source;
  const pipelineSourceKind = pipelineSource?.kind === "worker_workspace" ? "worker_workspace" : "repository";
  /** Only a worker that actually declares directories can host a "by key" pipeline. */
  const workspaceWorkers = workers.filter((worker) => worker.status !== "revoked" && (worker.workspaces?.length ?? 0) > 0);
  /** A "by path" pipeline needs no declared directory, so any live worker can host it. */
  const activeWorkers = workers.filter((worker) => worker.status !== "revoked");
  const sourceWorker = workers.find((worker) => worker.id === pipelineSource?.workspace?.workerId);

  // Follows the spec's own shape when a different pipeline is picked (or one loads with a path
  // already set); free to diverge from it afterwards while the operator is mid-edit, same as the
  // hook script drafts above.
  useEffect(() => {
    setWorkspaceNameMode(pipelineSource?.workspace?.path ? "path" : "key");
    setPendingWorkerWorkspace(false);
    setPendingWorkerId("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPipelineSpecId]);

  const displayedSourceKind = pipelineSourceKind === "worker_workspace" || pendingWorkerWorkspace ? "worker_workspace" : "repository";

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Пайплайны</h1>
          <p className="text-sm text-muted-foreground">
            Сначала выберите Codex или Claude для роли, затем назначьте роль и workspace каждой стадии.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ProjectPicker projects={projects} selectedProjectId={selectedProjectId} onSelect={setSelectedProjectId} />
          {selectedProject && (
            <a href={`${PREFIX}/agentiz?projectId=${selectedProject.id}`} className="text-xs underline">
              ← к проекту
            </a>
          )}
        </div>
      </div>

      {error && <div className="rounded border p-3 text-sm" style={{ borderColor: "#fecaca", backgroundColor: "#fef2f2", color: "#b91c1c" }}>{error}</div>}

      <div className="rounded-lg border p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">ACP-агенты и пайплайн</h2>
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
                  value={displayedSourceKind}
                  onChange={(event) => {
                    if (event.target.value === "repository") {
                      setPendingWorkerWorkspace(false);
                      setPipelineSource({ kind: "repository" });
                      return;
                    }
                    if (workspaceWorkers.length > 0) {
                      const worker = sourceWorker ?? workspaceWorkers[0];
                      const workspace = worker?.workspaces?.[0];
                      if (!worker || !workspace) return;
                      setWorkspaceNameMode("key");
                      setPendingWorkerWorkspace(false);
                      setPipelineSource({ kind: "worker_workspace", workspace: { workerId: worker.id, workspaceKey: workspace.key } });
                      return;
                    }
                    // No worker has declared a directory: switch the panel locally and let the
                    // operator name a path below before anything is saved. Persisting bare
                    // {kind:"worker_workspace"} would just bounce off the server's "workspaceKey or
                    // path" check.
                    if (activeWorkers.length === 0) return;
                    setWorkspaceNameMode("path");
                    setPendingWorkerId(sourceWorker?.id ?? activeWorkers[0].id);
                    setPendingWorkerWorkspace(true);
                  }}
                  disabled={busy || (displayedSourceKind === "repository" && activeWorkers.length === 0)}
                  className="rounded border px-2 py-1 disabled:opacity-50"
                >
                  <option value="repository">Репозиторий проекта (GitHub/GitLab)</option>
                  <option value="worker_workspace">Готовая папка на воркере</option>
                </select>

                {displayedSourceKind === "repository" && (
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

                {displayedSourceKind === "worker_workspace" && (
                  <select
                    value={workspaceNameMode}
                    onChange={(event) => {
                      const nextMode = event.target.value as "key" | "path";
                      if (nextMode === "key") {
                        if (workspaceWorkers.length === 0) return;
                        const currentWorkerId = pendingWorkerWorkspace ? pendingWorkerId : sourceWorker?.id;
                        const worker = workspaceWorkers.find((item) => item.id === currentWorkerId) ?? workspaceWorkers[0];
                        const workspace = worker.workspaces?.[0];
                        if (!workspace) return;
                        setWorkspaceNameMode("key");
                        setPendingWorkerWorkspace(false);
                        setPipelineSource({ kind: "worker_workspace", workspace: { workerId: worker.id, workspaceKey: workspace.key } });
                        return;
                      }
                      // Switching to "path" never fails: nothing is saved until the path editor's
                      // own save button runs, with a real (worker, path) pair in hand.
                      setWorkspaceNameMode("path");
                    }}
                    disabled={busy}
                    className="rounded border px-2 py-1 disabled:opacity-50"
                  >
                    <option value="key" disabled={workspaceWorkers.length === 0}>По ключу, объявленному на воркере</option>
                    <option value="path">Путь прямо здесь</option>
                  </select>
                )}

                {displayedSourceKind === "worker_workspace" && workspaceNameMode === "key" && (
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

                {displayedSourceKind === "worker_workspace" && workspaceNameMode === "path" && (
                  <select
                    value={pendingWorkerWorkspace ? pendingWorkerId : (sourceWorker?.id ?? "")}
                    onChange={(event) => {
                      if (pendingWorkerWorkspace) {
                        setPendingWorkerId(event.target.value);
                        return;
                      }
                      const worker = activeWorkers.find((item) => item.id === event.target.value);
                      if (!worker) return;
                      setPipelineSource({
                        kind: "worker_workspace",
                        workspace: {
                          workerId: worker.id,
                          path: pipelineSource?.workspace?.path ?? "",
                          createIfMissing: pipelineSource?.workspace?.createIfMissing ?? false,
                        },
                      });
                    }}
                    disabled={busy}
                    className="rounded border px-2 py-1 disabled:opacity-50"
                  >
                    {activeWorkers.map((worker) => <option key={worker.id} value={worker.id}>{worker.name}</option>)}
                  </select>
                )}
              </div>

              {displayedSourceKind === "worker_workspace" && workspaceNameMode === "path" && (
                <PipelineWorkspacePathEditor
                  workerId={pendingWorkerWorkspace ? pendingWorkerId : (sourceWorker?.id ?? "")}
                  savedPath={pendingWorkerWorkspace ? "" : (pipelineSource?.workspace?.path ?? "")}
                  savedCreateIfMissing={pendingWorkerWorkspace ? false : (pipelineSource?.workspace?.createIfMissing ?? false)}
                  busy={busy}
                  onSave={(path, createIfMissing) => {
                    const workerId = pendingWorkerWorkspace ? pendingWorkerId : (sourceWorker?.id ?? activeWorkers[0]?.id);
                    if (!workerId) return;
                    setPendingWorkerWorkspace(false);
                    setPipelineSource({ kind: "worker_workspace", workspace: { workerId, path, createIfMissing } });
                  }}
                />
              )}

              {pipelineSourceKind === "worker_workspace" ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Запуски этого пайплайна уходят только на выбранного воркера и выполняются прямо в{" "}
                  <code>
                    {pipelineSource?.workspace?.path
                      ?? sourceWorker?.workspaces?.find((item) => item.key === pipelineSource?.workspace?.workspaceKey)?.path
                      ?? "—"}
                  </code>
                  {pipelineSource?.workspace?.createIfMissing && " (будет создана, если её ещё нет)"}.
                  Стадии выполняются в режиме Host. Commit/push доступен только для объявленной папки,
                  которой администратор воркера явно разрешил Git push.
                </p>
              ) : pendingWorkerWorkspace ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Ни у одного воркера нет заранее объявленной папки — введите абсолютный путь выше и нажмите «Сохранить путь», чтобы завершить переключение.
                </p>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  {pipelineSource?.repositoryId
                    ? "Код берётся из выбранного репозитория и коммит уезжает обратно в него же. Комментарий по задаче уходит туда, где задача живёт."
                    : "Код берётся из репозитория, из которого пришла задача, и коммит уезжает туда же."}
                  {projectRepositories.length === 0 && (
                    <> Репозитории проекта настраиваются на <a href={`${PREFIX}/agentiz-repos`} className="underline">странице «Репозитории»</a>.</>
                  )}
                  {workspaceWorkers.length === 0 && activeWorkers.length === 0 && (
                    <> Ни одного воркера пока нет — заведите его на <a href={`${PREFIX}/agentiz-workers`} className="underline">странице «Воркеры»</a>.</>
                  )}
                </p>
              )}
            </div>

            {pipelineSourceKind === "worker_workspace" && (
              <div className="rounded border p-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">После выполнения</span>
                  <select value={selectedPipelineSpec.spec.finalAction.type} onChange={(event) => setWorkspaceDelivery(event.target.value as "commit" | "comment_only" | "none")} disabled={busy} className="rounded border px-2 py-1">
                    <option value="comment_only">Только результат в задаче</option>
                    <option value="none">Ничего</option>
                    <option value="commit" disabled={workspaceNameMode !== "key" || !sourceWorker?.workspaces?.find((item) => item.key === pipelineSource?.workspace?.workspaceKey)?.git?.pushEnabled || projectRepositories.length === 0}>Commit и push из workspace</option>
                  </select>
                  {selectedPipelineSpec.spec.finalAction.type === "commit" && (
                    <>
                      <select value={pipelineSource?.repositoryId ?? ""} onChange={(event) => void savePipelineSpec((current) => ({ ...current, source: { ...current.source, repositoryId: event.target.value } }), "Не удалось сохранить репозиторий")} disabled={busy} className="rounded border px-2 py-1">
                        {projectRepositories.map((link) => <option key={link.id} value={link.repositoryId}>{link.repository?.pathWithNamespace ?? link.repositoryId}</option>)}
                      </select>
                      <select value={selectedPipelineSpec.spec.finalAction.targetBranch?.mode ?? "new"} onChange={(event) => patchWorkspaceFinalAction({ targetBranch: { ...selectedPipelineSpec.spec.finalAction.targetBranch, mode: event.target.value } })} disabled={busy} className="rounded border px-2 py-1">
                        <option value="current">В исходную ветку</option>
                        <option value="new">В новую короткую ветку</option>
                      </select>
                      <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={selectedPipelineSpec.spec.finalAction.requireApproval === true} onChange={(event) => patchWorkspaceFinalAction({ requireApproval: event.target.checked })} />Требовать подтверждение</label>
                    </>
                  )}
                </div>
                {selectedPipelineSpec.spec.finalAction.type === "commit" && (
                  <div className="mt-2 grid gap-2 md:grid-cols-2">
                    {selectedPipelineSpec.spec.finalAction.targetBranch?.mode === "new" && <input defaultValue={selectedPipelineSpec.spec.finalAction.targetBranch?.prefix ?? "agentiz/"} onBlur={(event) => patchWorkspaceFinalAction({ targetBranch: { mode: "new", prefix: event.target.value.trim() || "agentiz/" } })} placeholder="Префикс ветки" className="rounded border px-2 py-1 text-xs" />}
                    <textarea defaultValue={selectedPipelineSpec.spec.finalAction.commitMessageTemplate ?? "{{title}}\n\n{{summary}}"} onBlur={(event) => patchWorkspaceFinalAction({ commitMessageTemplate: event.target.value })} rows={3} className="rounded border px-2 py-1 text-xs" />
                  </div>
                )}
              </div>
            )}

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
            <p className="text-xs text-muted-foreground">
              Модель роли можно переопределить только для этой стадии — поле «модель» ниже. Пусто
              значит «как в роли»; так одна роль может выполняться под разными моделями в разных
              пайплайнах или стадиях, не будучи склонированной.
            </p>
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
                <input
                  type="text"
                  value={stage.model ?? ""}
                  onChange={(event) => saveStage(index, { model: event.target.value || undefined })}
                  onBlur={(event) => saveStage(index, { model: event.target.value.trim() || undefined })}
                  disabled={busy}
                  placeholder={`модель роли (${roles.find((role) => role.key === stage.agentRoleKey)?.model ?? "не задана"})`}
                  title="Переопределяет модель роли только для этой стадии. Пусто = модель роли."
                  className="min-w-48 flex-1 rounded border px-2 py-1 text-xs disabled:opacity-50"
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default AgentizPipelines;
