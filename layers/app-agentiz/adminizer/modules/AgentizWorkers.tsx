import React, { useCallback, useEffect, useState } from "react";
import axios from "axios";

/**
 * The worker fleet: registering machines, watching whether they're still checking in, and scoping
 * what each one may claim. Split out of the project overview — workers are shared across every
 * project, so they don't belong under any one project's page.
 */
interface AgentProject {
  id: string;
  name: string;
}

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

interface RepositoryOption {
  id: string;
  provider: string;
  pathWithNamespace: string;
  connectionId: string;
}

interface IssuedToken {
  workerName: string;
  token: string;
  workerApiUrl: string;
}

const PREFIX = (window as any).routePrefix ?? "/dashboard";
const HOME_URL = `${PREFIX}/agentiz`;
const REPOS_URL = `${PREFIX}/agentiz-repos`;
const API_URL = `${PREFIX}/agentiz-workers`;

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

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
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
    <span className="inline-block rounded px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: swatch.bg, color: swatch.fg }}>
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

const AgentizWorkers: React.FC = () => {
  const [workers, setWorkers] = useState<AgentWorker[]>([]);
  const [workerApi, setWorkerApi] = useState<{ enabled: boolean; url: string }>({ enabled: false, url: "" });
  const [projects, setProjects] = useState<AgentProject[]>([]);
  const [repositoryOptions, setRepositoryOptions] = useState<RepositoryOption[]>([]);
  const [newWorkerName, setNewWorkerName] = useState("");
  /** An issued token is returned by the server exactly once — keep it on screen until dismissed. */
  const [issuedToken, setIssuedToken] = useState<IssuedToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const fetchProjects = useCallback(async () => {
    try {
      const res = await axios.get(HOME_URL, { params: { _method: "getProjects" } });
      setProjects(res.data?.data ?? []);
    } catch {
      setProjects([]);
    }
  }, []);

  const fetchRepositoryOptions = useCallback(async () => {
    try {
      const res = await axios.get(REPOS_URL, { params: { _method: "getRepositories" } });
      setRepositoryOptions(res.data?.data ?? []);
    } catch {
      // Not fatal: the allowlist selector simply stays empty.
      setRepositoryOptions([]);
    }
  }, []);

  useEffect(() => {
    fetchWorkers();
    fetchProjects();
    fetchRepositoryOptions();
  }, [fetchWorkers, fetchProjects, fetchRepositoryOptions]);

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

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Воркеры</h1>
          <p className="text-sm text-muted-foreground">
            Машины, которые забирают job'ы из очереди и выполняют стадии пайплайнов.
          </p>
        </div>
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

      {error && <div className="rounded border p-3 text-sm" style={{ borderColor: "#fecaca", backgroundColor: "#fef2f2", color: "#b91c1c" }}>{error}</div>}

      <div className="rounded-lg border p-4">
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
    </div>
  );
};

export default AgentizWorkers;
