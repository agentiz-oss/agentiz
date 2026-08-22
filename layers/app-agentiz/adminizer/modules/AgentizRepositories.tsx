import React, { useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";
import { formatDateTime, useViewerTimezone } from "./lib/viewerTime";
import { DocsButton } from "./components/DocsButton";

/**
 * Repositories of every platform in one place: which accounts are connected, what they can reach,
 * and which repositories each Agentiz project uses.
 *
 * Per-platform pages hold only their OAuth application — the part that is genuinely different
 * between GitLab and GitHub. Everything below is the same whatever the code is hosted on.
 */
interface Connection {
  id: string;
  provider: string;
  baseUrl: string | null;
  username: string | null;
  displayName: string | null;
  status: string;
  scope: string | null;
  expiresAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  repositoryCount: number;
  hasSecrets: boolean;
  /** False when the layer serving this provider is not mounted: nothing can be refreshed. */
  authorityMounted: boolean;
}

interface Repository {
  id: string;
  connectionId: string;
  provider: string;
  externalRepoId: string;
  pathWithNamespace: string;
  defaultBranch: string | null;
  visibility: string | null;
  issuesEnabled: boolean;
}

interface ProjectRepository {
  id: string;
  projectId: string;
  provider: string;
  role: string;
  isPrimary: boolean;
  syncIssues: boolean;
  isActive: boolean;
  config: { defaultBranch?: string } | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  repository: Repository | null;
  connection: Connection | null;
}

interface Project {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
}

const API_URL = `${(window as any).routePrefix ?? "/dashboard"}/agentiz-repos`;
const PREFIX = (window as any).routePrefix ?? "/dashboard";

const PROVIDER_TITLES: Record<string, string> = { github: "GitHub", gitlab: "GitLab" };

const ROLE_TITLES: Record<string, string> = {
  source: "Источник задач",
  target: "Цель коммитов",
  both: "Источник и цель",
};

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  active: { bg: "#d1fae5", fg: "#047857" },
  expired: { bg: "#fef3c7", fg: "#b45309" },
  revoked: { bg: "#f1f5f9", fg: "#64748b" },
  error: { bg: "#fee2e2", fg: "#b91c1c" },
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const swatch = STATUS_COLORS[status] ?? { bg: "#f1f5f9", fg: "#334155" };
  return (
    <span className="inline-block rounded px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: swatch.bg, color: swatch.fg }}>
      {status}
    </span>
  );
};

const AgentizRepositories: React.FC = () => {
  useViewerTimezone();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [providers, setProviders] = useState<Array<{ provider: string; route: string }>>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [links, setLinks] = useState<ProjectRepository[]>([]);
  const [repositories, setRepositories] = useState<Repository[]>([]);

  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [repoSearch, setRepoSearch] = useState("");
  const [showPicker, setShowPicker] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const call = useCallback(async (payload: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await axios.post(API_URL, payload);
      return res.data?.data;
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Запрос не удался");
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);

  const fetchConnections = useCallback(async () => {
    const res = await axios.get(API_URL, { params: { _method: "getConnections" } });
    const items: Connection[] = res.data?.data ?? [];
    setConnections(items);
    setProviders(res.data?.meta?.providers ?? []);
    setSelectedConnectionId((current) => current || items[0]?.id || "");
  }, []);

  const fetchProjects = useCallback(async () => {
    const res = await axios.get(API_URL, { params: { _method: "getProjects" } });
    const items: Project[] = res.data?.data ?? [];
    setProjects(items);
    setSelectedProjectId((current) => current || items[0]?.id || "");
  }, []);

  const fetchLinks = useCallback(async (projectId: string) => {
    if (!projectId) {
      setLinks([]);
      return;
    }
    const res = await axios.get(API_URL, { params: { _method: "getProjectRepositories", projectId } });
    setLinks(res.data?.data ?? []);
  }, []);

  const fetchRepositories = useCallback(async (connectionId: string) => {
    if (!connectionId) {
      setRepositories([]);
      return;
    }
    const res = await axios.get(API_URL, { params: { _method: "getRepositories", connectionId } });
    setRepositories(res.data?.data ?? []);
  }, []);

  useEffect(() => {
    void fetchConnections().catch(() => setError("Не удалось загрузить подключения"));
    void fetchProjects().catch(() => setError("Не удалось загрузить проекты"));
  }, [fetchConnections, fetchProjects]);

  useEffect(() => {
    void fetchLinks(selectedProjectId).catch(() => setError("Не удалось загрузить репозитории проекта"));
  }, [selectedProjectId, fetchLinks]);

  useEffect(() => {
    void fetchRepositories(selectedConnectionId).catch(() => setError("Не удалось загрузить репозитории"));
  }, [selectedConnectionId, fetchRepositories]);

  const linkedIds = useMemo(
    () => new Set(links.map((link) => link.repository?.id).filter(Boolean) as string[]),
    [links],
  );

  const pickable = useMemo(() => {
    const search = repoSearch.trim().toLowerCase();
    return repositories
      .filter((repository) => !linkedIds.has(repository.id))
      .filter((repository) => (search ? repository.pathWithNamespace.toLowerCase().includes(search) : true))
      .slice(0, 50);
  }, [repositories, repoSearch, linkedIds]);

  const syncRepositories = useCallback(
    async (connectionId: string) => {
      const data = await call({ _method: "syncConnectionRepositories", connectionId });
      const first = Array.isArray(data) ? data[0] : data;
      setNotice(`Репозитории обновлены: получено ${first?.fetched ?? 0}, новых ${first?.created ?? 0}`);
      await fetchConnections();
      await fetchRepositories(connectionId);
    },
    [call, fetchConnections, fetchRepositories],
  );

  const linkRepository = useCallback(
    async (repositoryId: string) => {
      await call({ _method: "linkRepository", projectId: selectedProjectId, repositoryId });
      setShowPicker(false);
      await fetchLinks(selectedProjectId);
    },
    [call, selectedProjectId, fetchLinks],
  );

  const updateLink = useCallback(
    async (linkId: string, patch: Record<string, unknown>) => {
      await call({ _method: "updateProjectRepository", linkId, ...patch });
      await fetchLinks(selectedProjectId);
    },
    [call, selectedProjectId, fetchLinks],
  );

  const unlink = useCallback(
    async (linkId: string) => {
      if (!window.confirm("Отвязать репозиторий от проекта? Синхронизированные задачи останутся.")) return;
      await call({ _method: "unlinkRepository", linkId });
      await fetchLinks(selectedProjectId);
    },
    [call, selectedProjectId, fetchLinks],
  );

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Репозитории</h1>
          <p className="text-sm text-muted-foreground">
            Подключённые аккаунты, доступные через них репозитории и привязки к проектам Agentiz —
            для GitHub и GitLab одновременно.
          </p>
        </div>
        <DocsButton />
      </div>

      {error && <div className="rounded border p-3 text-sm" style={{ borderColor: "#fecaca", backgroundColor: "#fef2f2", color: "#b91c1c" }}>{error}</div>}
      {notice && <div className="rounded border p-3 text-sm" style={{ borderColor: "#a7f3d0", backgroundColor: "#ecfdf5", color: "#047857" }}>{notice}</div>}

      <div className="rounded-lg border p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Подключения</h2>
          <div className="flex flex-wrap gap-2">
            {/* Only platforms whose layer is mounted are offered — anything else would 404. */}
            {providers.map((item) => (
              <a
                key={item.provider}
                href={`${PREFIX}${item.route}`}
                className="rounded border px-3 py-1.5 text-sm font-medium"
              >
                Подключить {PROVIDER_TITLES[item.provider] ?? item.provider}
              </a>
            ))}
          </div>
        </div>

        {connections.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Ни один аккаунт не подключён. Начните с OAuth-приложения на странице провайдера.
          </p>
        )}
        <ul className="space-y-2">
          {connections.map((connection) => (
            <li key={connection.id} className="rounded border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={connection.status} />
                <span className="font-medium">{PROVIDER_TITLES[connection.provider] ?? connection.provider}</span>
                <span className="text-sm">{connection.username ?? connection.displayName ?? "—"}</span>
                <span className="text-xs text-muted-foreground">{connection.baseUrl}</span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                репозиториев: {connection.repositoryCount} · последняя синхронизация:{" "}
                {connection.lastSyncedAt ? formatDateTime(connection.lastSyncedAt) : "никогда"}
                {connection.expiresAt && ` · токен до ${formatDateTime(connection.expiresAt)}`}
              </div>
              {!connection.authorityMounted && (
                <div className="mt-1 text-xs" style={{ color: "#b45309" }}>
                  Слой {PROVIDER_TITLES[connection.provider] ?? connection.provider} не смонтирован: обновить токен и
                  пересинхронизировать репозитории нельзя.
                </div>
              )}
              {connection.lastError && (
                <div className="mt-1 text-xs" style={{ color: "#b91c1c" }}>{connection.lastError}</div>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  onClick={() => syncRepositories(connection.id)}
                  disabled={busy || !connection.authorityMounted || connection.status !== "active"}
                  className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                >
                  Синхронизировать репозитории
                </button>
                <button
                  onClick={() => setSelectedConnectionId(connection.id)}
                  disabled={busy}
                  className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                >
                  Показать репозитории
                </button>
                {connection.status === "active" && (
                  <button
                    onClick={async () => {
                      if (!window.confirm("Отключить аккаунт? Токен будет отозван, привязки останутся.")) return;
                      await call({ _method: "disconnectConnection", connectionId: connection.id });
                      await fetchConnections();
                    }}
                    disabled={busy}
                    className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                    style={{ borderColor: "#fcd34d", color: "#b45309" }}
                  >
                    Отключить
                  </button>
                )}
                <button
                  onClick={async () => {
                    if (!window.confirm("Удалить подключение? Вместе с ним исчезнут его репозитории и привязки.")) return;
                    await call({ _method: "deleteConnection", connectionId: connection.id });
                    await fetchConnections();
                    await fetchLinks(selectedProjectId);
                  }}
                  disabled={busy}
                  className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                  style={{ borderColor: "#fca5a5", color: "#b91c1c" }}
                >
                  Удалить
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-lg border p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Репозитории проекта</h2>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedProjectId}
              onChange={(event) => setSelectedProjectId(event.target.value)}
              className="rounded border px-2 py-1 text-sm"
            >
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <button
              onClick={() => setShowPicker((value) => !value)}
              disabled={busy || !selectedProjectId}
              className="rounded border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            >
              {showPicker ? "Отмена" : "Добавить репозиторий"}
            </button>
          </div>
        </div>

        {showPicker && (
          <div className="mb-4 rounded border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={selectedConnectionId}
                onChange={(event) => setSelectedConnectionId(event.target.value)}
                className="rounded border px-2 py-1 text-sm"
              >
                {connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {PROVIDER_TITLES[connection.provider] ?? connection.provider} · {connection.username ?? connection.id.slice(0, 8)}
                  </option>
                ))}
              </select>
              <input
                value={repoSearch}
                onChange={(event) => setRepoSearch(event.target.value)}
                placeholder="поиск по пути"
                className="rounded border px-2 py-1 text-sm"
              />
            </div>
            {pickable.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Ничего не найдено. Если репозиторий новый — сначала синхронизируйте подключение.
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {pickable.map((repository) => (
                  <li key={repository.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm">
                    <span>
                      <code>{repository.pathWithNamespace}</code>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {PROVIDER_TITLES[repository.provider] ?? repository.provider}
                        {repository.defaultBranch ? ` · ${repository.defaultBranch}` : ""}
                        {repository.visibility ? ` · ${repository.visibility}` : ""}
                      </span>
                    </span>
                    <button
                      onClick={() => linkRepository(repository.id)}
                      disabled={busy}
                      className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                    >
                      Привязать
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {links.length === 0 ? (
          <p className="text-sm text-muted-foreground">У проекта пока нет привязанных репозиториев.</p>
        ) : (
          <ul className="space-y-2">
            {links.map((link) => (
              <li key={link.id} className="rounded border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium"><code>{link.repository?.pathWithNamespace ?? "—"}</code></span>
                  <span className="text-xs text-muted-foreground">
                    {PROVIDER_TITLES[link.provider] ?? link.provider}
                    {link.connection?.username ? ` · ${link.connection.username}` : ""}
                  </span>
                  {!link.isActive && <span className="text-xs" style={{ color: "#b45309" }}>выключен</span>}
                </div>
                {link.lastError && <div className="mt-1 text-xs" style={{ color: "#b91c1c" }}>{link.lastError}</div>}
                <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
                  <select
                    value={link.role}
                    onChange={(event) => updateLink(link.id, { role: event.target.value })}
                    disabled={busy}
                    className="rounded border px-2 py-1 text-xs disabled:opacity-50"
                  >
                    {Object.entries(ROLE_TITLES).map(([value, title]) => <option key={value} value={value}>{title}</option>)}
                  </select>
                  {/* Radio, not a checkbox: "primary" is one per project, and the server demotes
                      the previous one on write. */}
                  <label className="flex items-center gap-1 text-xs">
                    <input
                      type="radio"
                      name="primary"
                      checked={link.isPrimary}
                      onChange={() => updateLink(link.id, { isPrimary: true })}
                      disabled={busy}
                    />
                    основной
                  </label>
                  <label className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={link.syncIssues}
                      onChange={(event) => updateLink(link.id, { syncIssues: event.target.checked })}
                      disabled={busy}
                    />
                    синхронизировать задачи
                  </label>
                  <label className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={link.isActive}
                      onChange={(event) => updateLink(link.id, { isActive: event.target.checked })}
                      disabled={busy}
                    />
                    активна
                  </label>
                  <label className="flex items-center gap-1 text-xs">
                    ветка
                    <input
                      defaultValue={link.config?.defaultBranch ?? ""}
                      placeholder={link.repository?.defaultBranch ?? "default"}
                      onBlur={(event) => {
                        const value = event.target.value.trim();
                        if (value === (link.config?.defaultBranch ?? "")) return;
                        updateLink(link.id, { config: { ...(link.config ?? {}), defaultBranch: value || undefined } });
                      }}
                      className="w-32 rounded border px-2 py-1 text-xs"
                    />
                  </label>
                  <button
                    onClick={() => unlink(link.id)}
                    disabled={busy}
                    className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                    style={{ borderColor: "#fca5a5", color: "#b91c1c" }}
                  >
                    Отвязать
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default AgentizRepositories;
