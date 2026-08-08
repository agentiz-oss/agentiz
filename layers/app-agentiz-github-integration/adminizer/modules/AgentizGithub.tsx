import React, { useCallback, useEffect, useState } from "react";
import axios from "axios";

/**
 * The whole GitHub-specific screen: the OAuth application and the button that starts the flow.
 *
 * Everything after authorization — connections, mirrored repositories, links to projects — is
 * shared with every other platform and lives on the core repositories screen, so it is deliberately
 * not duplicated here.
 */
interface OAuthApp {
  id: string;
  name: string;
  baseUrl: string;
  clientId: string;
  redirectUri: string | null;
  callbackUrl: string;
  scopes: string[] | null;
  isActive: boolean;
}

const API_URL = `${(window as any).routePrefix ?? "/dashboard"}/agentiz-github`;

const emptyAppForm = { name: "", baseUrl: "https://github.com", clientId: "", clientSecret: "", redirectUri: "" };

const AgentizGithub: React.FC = () => {
  const [apps, setApps] = useState<OAuthApp[]>([]);
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

  useEffect(() => {
    void fetchApps().catch(() => setError("Не удалось загрузить OAuth-приложения"));
  }, [fetchApps]);

  const createApp = useCallback(async () => {
    await call({ _method: "createOAuthApp", ...appForm });
    setAppForm(emptyAppForm);
    setShowAppForm(false);
    await fetchApps();
  }, [appForm, call, fetchApps]);

  const deleteApp = useCallback(
    async (id: string) => {
      if (!window.confirm("Удалить OAuth-приложение? Уже выданные подключения перестанут обновлять токен.")) return;
      await call({ _method: "deleteOAuthApp", id });
      await fetchApps();
    },
    [call, fetchApps],
  );

  const connect = useCallback(
    async (oauthAppId: string) => {
      const data = await call({ _method: "startOAuth", oauthAppId, returnTo: window.location.pathname });
      if (data?.authorizeUrl) window.location.href = data.authorizeUrl;
    },
    [call],
  );

  const syncRepositories = useCallback(async () => {
    const data = await call({ _method: "syncRepositories" });
    const total = (Array.isArray(data) ? data : []).reduce(
      (acc: { fetched: number; created: number }, item: any) => ({
        fetched: acc.fetched + (item?.fetched ?? 0),
        created: acc.created + (item?.created ?? 0),
      }),
      { fetched: 0, created: 0 },
    );
    setNotice(`Репозитории обновлены: получено ${total.fetched}, новых ${total.created}`);
  }, [call]);

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">GitHub-интеграция</h1>
        <p className="text-sm text-muted-foreground">
          Авторизация через OAuth-приложение GitHub. Подключения, репозитории и привязки к проектам —
          на общем экране репозиториев.
        </p>
      </div>

      {error && <div className="rounded border p-3 text-sm" style={{ borderColor: "#fecaca", backgroundColor: "#fef2f2", color: "#b91c1c" }}>{error}</div>}
      {notice && <div className="rounded border p-3 text-sm" style={{ borderColor: "#a7f3d0", backgroundColor: "#ecfdf5", color: "#047857" }}>{notice}</div>}

      <div className="rounded-lg border p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">OAuth-приложения</h2>
          <div className="flex gap-2">
            <button onClick={syncRepositories} disabled={busy} className="rounded border px-3 py-1.5 text-sm font-medium disabled:opacity-50">
              Синхронизировать репозитории
            </button>
            <button onClick={() => setShowAppForm((v) => !v)} className="rounded border px-3 py-1.5 text-sm font-medium">
              {showAppForm ? "Отмена" : "Добавить приложение"}
            </button>
          </div>
        </div>

        {showAppForm && (
          <div className="mb-4 grid gap-2 rounded border p-3 md:grid-cols-2">
            {([
              ["name", "Название"],
              ["baseUrl", "URL GitHub (или GHE)"],
              ["clientId", "Client ID"],
              ["clientSecret", "Client secret"],
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
                disabled={busy || !appForm.clientId}
                className="rounded border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
              >
                Сохранить
              </button>
            </div>
          </div>
        )}

        {apps.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Приложений пока нет. Создайте OAuth App в GitHub (Settings → Developer settings → OAuth Apps)
            и перенесите сюда Client ID и secret.
          </p>
        )}
        <ul className="space-y-2">
          {apps.map((app) => (
            <li key={app.id} className="rounded border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{app.name}</span>
                <span className="text-xs text-muted-foreground">{app.baseUrl}</span>
                {!app.isActive && <span className="text-xs" style={{ color: "#b91c1c" }}>отключено</span>}
              </div>
              {/* Пункт, который чаще всего настраивают неправильно, поэтому он готов к вставке. */}
              <div className="mt-1 text-xs text-muted-foreground">
                Authorization callback URL для GitHub: <code>{app.callbackUrl}</code>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                Скоупы: <code>{(app.scopes ?? []).join(" ") || "по умолчанию"}</code>
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => connect(app.id)}
                  disabled={busy || !app.isActive}
                  className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                >
                  Подключить аккаунт GitHub
                </button>
                <button
                  onClick={() => deleteApp(app.id)}
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
    </div>
  );
};

export default AgentizGithub;
