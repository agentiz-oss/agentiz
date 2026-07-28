import React, { useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";

interface OAuthApp {
  id: string;
  name: string;
  baseUrl: string;
  applicationId: string;
  redirectUri: string | null;
  callbackUrl: string;
  scopes: string[] | null;
  isActive: boolean;
}

interface Connection {
  id: string;
  oauthAppId: string;
  oauthAppName: string | null;
  baseUrl: string | null;
  username: string | null;
  displayName: string | null;
  status: string;
  scope: string | null;
  expiresAt: string | null;
  lastError: string | null;
  lastSyncedAt: string | null;
}

interface Repository {
  id: string;
  connectionId: string;
  gitlabProjectId: number;
  pathWithNamespace: string;
  webUrl: string | null;
  defaultBranch: string | null;
  visibility: string | null;
  issuesEnabled: boolean;
}

interface Integration {
  id: string;
  projectId: string;
  provider: string;
  role: string;
  isPrimary: boolean;
  syncIssues: boolean;
  isActive: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  repository: Repository | null;
  connection: Connection | null;
}

interface AgentProject {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
}

const API_URL = `${(window as any).routePrefix ?? "/dashboard"}/agentiz-gitlab`;

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-700",
  expired: "bg-amber-100 text-amber-700",
  revoked: "bg-slate-100 text-slate-500",
  error: "bg-red-100 text-red-700",
};

const ROLE_TITLES: Record<string, string> = {
  source: "Источник задач",
  target: "Цель коммитов",
  both: "Источник и цель",
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => (
  <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[status] ?? "bg-slate-100 text-slate-700"}`}>
    {status}
  </span>
);

const emptyAppForm = { name: "", baseUrl: "https://gitlab.com", applicationId: "", clientSecret: "", redirectUri: "" };

const AgentizGitlab: React.FC = () => {
  const [apps, setApps] = useState<OAuthApp[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [projects, setProjects] = useState<AgentProject[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [repositories, setRepositories] = useState<Repository[]>([]);

  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [repoSearch, setRepoSearch] = useState("");
  const [appForm, setAppForm] = useState(emptyAppForm);
  const [showAppForm, setShowAppForm] = useState(false);

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

  const fetchApps = useCallback(async () => {
    const res = await axios.get(API_URL, { params: { _method: "getOAuthApps" } });
    setApps(res.data?.data ?? []);
  }, []);

  const fetchConnections = useCallback(async () => {
    const res = await axios.get(API_URL, { params: { _method: "getConnections" } });
    const items: Connection[] = res.data?.data ?? [];
    setConnections(items);
    setSelectedConnectionId((current) => current || items[0]?.id || "");
  }, []);

  const fetchProjects = useCallback(async () => {
    const res = await axios.get(API_URL, { params: { _method: "getProjects" } });
    const items: AgentProject[] = res.data?.data ?? [];
    setProjects(items);
    setSelectedProjectId((current) => current || items[0]?.id || "");
  }, []);

  const fetchIntegrations = useCallback(async (projectId: string) => {
    if (!projectId) {
      setIntegrations([]);
      return;
    }
    const res = await axios.get(API_URL, { params: { _method: "getIntegrations", projectId } });
    setIntegrations(res.data?.data ?? []);
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
    void fetchApps().catch(() => setError("Не удалось загрузить OAuth-приложения"));
    void fetchConnections().catch(() => setError("Не удалось загрузить подключения"));
    void fetchProjects().catch(() => setError("Не удалось загрузить проекты"));
  }, [fetchApps, fetchConnections, fetchProjects]);

  useEffect(() => {
    void fetchIntegrations(selectedProjectId).catch(() => setError("Не удалось загрузить интеграции"));
  }, [selectedProjectId, fetchIntegrations]);

  useEffect(() => {
    void fetchRepositories(selectedConnectionId).catch(() => setError("Не удалось загрузить репозитории"));
  }, [selectedConnectionId, fetchRepositories]);

  const linkedRepositoryIds = useMemo(
    () => new Set(integrations.map((integration) => integration.repository?.id).filter(Boolean) as string[]),
    [integrations],
  );

  const visibleRepositories = useMemo(() => {
    const search = repoSearch.trim().toLowerCase();
    return repositories
      .filter((repo) => !linkedRepositoryIds.has(repo.id))
      .filter((repo) => (search ? repo.pathWithNamespace.toLowerCase().includes(search) : true))
      .slice(0, 50);
  }, [repositories, repoSearch, linkedRepositoryIds]);

  const createApp = useCallback(async () => {
    await call({ _method: "createOAuthApp", ...appForm });
    setAppForm(emptyAppForm);
    setShowAppForm(false);
    await fetchApps();
  }, [appForm, call, fetchApps]);

  const connect = useCallback(
    async (oauthAppId: string) => {
      const data = await call({ _method: "startOAuth", oauthAppId, returnTo: window.location.pathname });
      if (data?.authorizeUrl) window.location.href = data.authorizeUrl;
    },
    [call],
  );

  const syncRepositories = useCallback(
    async (connectionId: string) => {
      const data = await call({ _method: "syncRepositories", connectionId });
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
      await fetchIntegrations(selectedProjectId);
    },
    [call, selectedProjectId, fetchIntegrations],
  );

  const updateIntegration = useCallback(
    async (integrationId: string, patch: Record<string, unknown>) => {
      await call({ _method: "updateIntegration", integrationId, ...patch });
      await fetchIntegrations(selectedProjectId);
    },
    [call, selectedProjectId, fetchIntegrations],
  );

  const unlink = useCallback(
    async (integrationId: string) => {
      await call({ _method: "unlinkIntegration", integrationId });
      await fetchIntegrations(selectedProjectId);
    },
    [call, selectedProjectId, fetchIntegrations],
  );

  const syncIntegration = useCallback(
    async (integrationId: string) => {
      const data = await call({ _method: "syncIntegration", integrationId });
      setNotice(`Задачи синхронизированы: получено ${data?.fetched ?? 0}, новых ${data?.created ?? 0}`);
      await fetchIntegrations(selectedProjectId);
    },
    [call, selectedProjectId, fetchIntegrations],
  );

  const syncProjectIntegrations = useCallback(async () => {
    const data = await call({ _method: "syncProjectIntegrations", projectId: selectedProjectId });
    setNotice(`Задачи проекта синхронизированы: получено ${data?.fetched ?? 0}, новых ${data?.created ?? 0}`);
    await fetchIntegrations(selectedProjectId);
  }, [call, selectedProjectId, fetchIntegrations]);

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">GitLab-интеграции</h1>
        <p className="text-sm text-muted-foreground">
          Авторизация через OAuth-приложение GitLab, синхронизация репозиториев и привязка любого их числа
          к проекту Agentiz.
        </p>
      </div>

      {error && <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {notice && <div className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</div>}

      <div className="rounded-lg border p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">OAuth-приложения</h2>
          <button onClick={() => setShowAppForm((v) => !v)} className="rounded border px-3 py-1.5 text-sm font-medium">
            {showAppForm ? "Отмена" : "Добавить приложение"}
          </button>
        </div>

        {showAppForm && (
          <div className="mb-4 grid gap-2 rounded border p-3 md:grid-cols-2">
            {([
              ["name", "Название"],
              ["baseUrl", "URL GitLab"],
              ["applicationId", "Application ID"],
              ["clientSecret", "Secret"],
              ["redirectUri", "Redirect URI (необязательно)"],
            ] as const).map(([field, label]) => (
              <label key={field} className="text-sm">
                <span className="mb-1 block text-xs text-muted-foreground">{label}</span>
                <input
                  className="w-full rounded border px-2 py-1.5 text-sm"
                  type={field === "clientSecret" ? "password" : "text"}
                  value={(appForm as any)[field]}
                  onChange={(e) => setAppForm((form) => ({ ...form, [field]: e.target.value }))}
                />
              </label>
            ))}
            <div className="md:col-span-2">
              <button
                onClick={createApp}
                disabled={busy || !appForm.applicationId}
                className="rounded border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
              >
                Сохранить
              </button>
            </div>
          </div>
        )}

        {apps.length === 0 && <p className="text-sm text-muted-foreground">Приложений пока нет.</p>}
        <ul className="space-y-2">
          {apps.map((app) => (
            <li key={app.id} className="rounded border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{app.name}</span>
                <span className="text-xs text-muted-foreground">{app.baseUrl}</span>
                {!app.isActive && <span className="text-xs text-red-600">отключено</span>}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                Callback URL для GitLab: <code>{app.callbackUrl}</code>
              </div>
              <div className="mt-2">
                <button
                  onClick={() => connect(app.id)}
                  disabled={busy || !app.isActive}
                  className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                >
                  Подключить аккаунт GitLab
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-lg border p-4">
        <h2 className="mb-3 text-lg font-semibold">Подключения</h2>
        {connections.length === 0 && (
          <p className="text-sm text-muted-foreground">Ни один аккаунт GitLab ещё не авторизован.</p>
        )}
        <ul className="space-y-2">
          {connections.map((connection) => (
            <li key={connection.id} className="rounded border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={connection.status} />
                <span className="font-medium">{connection.username ?? connection.displayName ?? connection.id}</span>
                <span className="text-xs text-muted-foreground">
                  {connection.oauthAppName} · {connection.baseUrl}
                </span>
              </div>
              {connection.lastError && <div className="mt-1 text-xs text-red-600">{connection.lastError}</div>}
              <div className="mt-2 flex flex-wrap gap-3">
                <button
                  onClick={() => syncRepositories(connection.id)}
                  disabled={busy}
                  className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                >
                  Синхронизировать репозитории
                </button>
                <button
                  onClick={() => call({ _method: "disconnect", connectionId: connection.id }).then(fetchConnections)}
                  disabled={busy}
                  className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                >
                  Отозвать токен
                </button>
                <span className="text-xs text-muted-foreground">
                  Репозитории обновлялись: {connection.lastSyncedAt ?? "никогда"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-lg border p-4">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">Привязка репозиториев к проекту</h2>
          <select
            value={selectedProjectId}
            onChange={(e) => setSelectedProjectId(e.target.value)}
            className="rounded border px-2 py-1.5 text-sm"
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <button
            onClick={syncProjectIntegrations}
            disabled={busy || !selectedProjectId}
            className="rounded border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            Синхронизировать задачи проекта
          </button>
        </div>

        {integrations.length === 0 && (
          <p className="text-sm text-muted-foreground">К этому проекту ещё не привязан ни один репозиторий.</p>
        )}
        <ul className="space-y-2">
          {integrations.map((integration) => (
            <li key={integration.id} className="rounded border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{integration.repository?.pathWithNamespace ?? "(репозиторий удалён)"}</span>
                {integration.isPrimary && (
                  <span className="rounded bg-violet-100 px-1.5 py-0.5 text-xs text-violet-700">основной</span>
                )}
                {!integration.isActive && <span className="text-xs text-red-600">отключено</span>}
                <span className="text-xs text-muted-foreground">
                  {integration.connection?.username} · {integration.repository?.defaultBranch ?? "—"}
                </span>
              </div>
              {integration.lastError && <div className="mt-1 text-xs text-red-600">{integration.lastError}</div>}
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <select
                  value={integration.role}
                  onChange={(e) => updateIntegration(integration.id, { role: e.target.value })}
                  className="rounded border px-2 py-1 text-xs"
                >
                  {Object.entries(ROLE_TITLES).map(([value, title]) => (
                    <option key={value} value={value}>
                      {title}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={integration.syncIssues}
                    onChange={(e) => updateIntegration(integration.id, { syncIssues: e.target.checked })}
                  />
                  синхронизировать задачи
                </label>
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={integration.isPrimary}
                    onChange={(e) => updateIntegration(integration.id, { isPrimary: e.target.checked })}
                  />
                  основной репозиторий
                </label>
                <button
                  onClick={() => syncIntegration(integration.id)}
                  disabled={busy}
                  className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                >
                  Синхронизировать
                </button>
                <button
                  onClick={() => unlink(integration.id)}
                  disabled={busy}
                  className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                >
                  Отвязать
                </button>
                {integration.repository?.webUrl && (
                  <a href={integration.repository.webUrl} target="_blank" rel="noreferrer" className="text-xs underline">
                    Открыть в GitLab
                  </a>
                )}
                <span className="text-xs text-muted-foreground">
                  Последняя синхронизация: {integration.lastSyncedAt ?? "никогда"}
                </span>
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-4 rounded border p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Добавить репозиторий</span>
            <select
              value={selectedConnectionId}
              onChange={(e) => setSelectedConnectionId(e.target.value)}
              className="rounded border px-2 py-1 text-xs"
            >
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.username} · {connection.baseUrl}
                </option>
              ))}
            </select>
            <input
              value={repoSearch}
              onChange={(e) => setRepoSearch(e.target.value)}
              placeholder="поиск по пути"
              className="rounded border px-2 py-1 text-xs"
            />
          </div>
          {visibleRepositories.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Ничего не найдено — синхронизируйте репозитории подключения.
            </p>
          )}
          <ul className="space-y-1">
            {visibleRepositories.map((repo) => (
              <li key={repo.id} className="flex flex-wrap items-center gap-2 text-sm">
                <button
                  onClick={() => linkRepository(repo.id)}
                  disabled={busy || !selectedProjectId}
                  className="rounded border px-2 py-0.5 text-xs font-medium disabled:opacity-50"
                >
                  Привязать
                </button>
                <span>{repo.pathWithNamespace}</span>
                <span className="text-xs text-muted-foreground">
                  {repo.visibility} · {repo.defaultBranch ?? "—"}
                  {repo.issuesEnabled ? "" : " · issues выключены"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
};

export default AgentizGitlab;
