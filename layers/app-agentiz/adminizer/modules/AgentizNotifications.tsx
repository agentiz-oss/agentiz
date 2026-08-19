import React, { useCallback, useEffect, useState } from "react";
import axios from "axios";
import NotificationPolicySection from "./components/NotificationPolicySection";

/**
 * Notifications, the whole picture: the `defaults` scope — the tail of every resolution — and a
 * list of every place that overrides it.
 *
 * The list is the reason this page exists. Overrides are made where the thing lives (a project
 * card, a pipeline editor), so without one screen that walks the document, an override made months
 * ago is unfindable and the silence it causes has no visible reason. Each row links back to the
 * screen that owns it rather than editing in place: one editor per scope, no second source of truth.
 */

interface Override {
  scope: "defaults" | "project" | "pipeline";
  id?: string;
  name: string;
  projectId?: string;
  projectName?: string;
  mute: boolean;
  types: string[];
}

const PREFIX = (window as any).routePrefix ?? "/dashboard";
const API_URL = `${PREFIX}/agentiz-notifications`;

const SCOPE_TITLES: Record<Override["scope"], string> = {
  defaults: "общие",
  project: "проект",
  pipeline: "пайплайн",
};

/** Where the scope is actually edited — the list only points, it never becomes a second editor. */
function editorHref(override: Override): string | null {
  if (override.scope === "project") return `${PREFIX}/agentiz?projectId=${override.id}`;
  if (override.scope === "pipeline") {
    const project = override.projectId ? `projectId=${override.projectId}&` : "";
    return `${PREFIX}/agentiz-pipelines?${project}specId=${override.id}`;
  }
  return null;
}

const AgentizNotifications: React.FC = () => {
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await axios.get(API_URL, { params: { _method: "getOverrides" } });
      setOverrides(res.data?.data ?? []);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Не удалось загрузить список переопределений");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Уведомления</h1>
          <p className="text-sm text-muted-foreground">
            Общие правила и всё, что их переопределяет. Лента активностей пишется всегда — здесь
            настраивается только доставка: пуш на телефон и колокольчик в панели.
          </p>
        </div>
        <a href={`${PREFIX}/agentiz`} className="text-xs underline">← к проектам</a>
      </div>

      {error && (
        <div className="rounded border p-3 text-sm" style={{ borderColor: "#fecaca", backgroundColor: "#fef2f2", color: "#b91c1c" }}>
          {error}
        </div>
      )}

      <NotificationPolicySection scope="defaults" inheritsFrom="из встроенных значений" onSaved={load} />

      <div className="rounded-lg border p-4">
        <h3 className="text-sm font-semibold">Где переопределено</h3>
        <p className="text-xs text-muted-foreground">
          Проекты и пайплайны со своими правилами. Правится там же, где живёт сама сущность.
        </p>

        {overrides.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Нигде — всё работает по общим правилам выше.
          </p>
        ) : (
          <ul className="mt-3 space-y-1">
            {overrides.map((override) => {
              const href = editorHref(override);
              return (
                <li key={`${override.scope}:${override.id ?? "defaults"}`} className="flex flex-wrap items-center gap-2 rounded border p-2 text-sm">
                  <span className="rounded px-2 py-0.5 text-xs" style={{ backgroundColor: "#f1f5f9", color: "#334155" }}>
                    {SCOPE_TITLES[override.scope]}
                  </span>
                  <span className="font-medium">{override.name}</span>
                  {override.projectName && (
                    <span className="text-xs text-muted-foreground">· {override.projectName}</span>
                  )}
                  {override.mute && (
                    <span className="rounded px-2 py-0.5 text-xs" style={{ backgroundColor: "#fee2e2", color: "#b91c1c" }}>
                      замьючено
                    </span>
                  )}
                  {override.types.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      правил: {override.types.length} ({override.types.join(", ")})
                    </span>
                  )}
                  {href && <a href={href} className="ml-auto text-xs underline">настроить →</a>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

export default AgentizNotifications;
