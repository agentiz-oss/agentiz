import React, { useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";

/**
 * The notification-policy editor for one scope of AGENTIZ_NOTIFY_POLICY.
 *
 * One component for all three scopes on purpose: `defaults`, a project and a pipeline differ only
 * in what they inherit from, and the resolution chain (pipeline → project → defaults → built-in)
 * is invisible unless every editor shows it the same way. Hence the third state of every select —
 * "наследуется", meaning this scope stores nothing for that channel and the value below it wins.
 *
 * The server answers with both `effective` and `inherited` per type (`describeScope`), so the hint
 * next to a select is the real resolution result, not a guess made in the browser.
 *
 * Saving goes through `patchScope`, which merges into the stored document: the project card, the
 * pipeline editor and the defaults page can be open at once without overwriting each other.
 */

const PREFIX = (window as any).routePrefix ?? "/dashboard";
const API_URL = `${PREFIX}/agentiz`;

type PushMode = "on" | "silent" | "off";
type DashboardMode = "on" | "off";

interface ChannelPolicy {
  push: PushMode;
  dashboard: DashboardMode;
}

interface PolicyEntry {
  push?: PushMode;
  dashboard?: DashboardMode;
}

interface TypeView {
  type: string;
  kind: string;
  label: string;
  own: PolicyEntry;
  effective: ChannelPolicy;
  inherited: ChannelPolicy;
}

interface ScopeView {
  scope: "defaults" | "project" | "pipeline";
  id?: string;
  mute: boolean;
  types: TypeView[];
  source: "environment" | "settings" | "unset";
  shadowedByEnvironment: boolean;
  warnings: string[];
}

const PUSH_TITLES: Record<PushMode, string> = {
  on: "будить",
  silent: "тихо",
  off: "не слать",
};

const DASHBOARD_TITLES: Record<DashboardMode, string> = { on: "слать", off: "не слать" };

export interface NotificationPolicySectionProps {
  scope: "defaults" | "project" | "pipeline";
  /** Required for project/pipeline scopes; the id whose entry is edited. */
  id?: string;
  /** What this scope falls back to, in words — shown under the heading. */
  inheritsFrom?: string;
}

const NotificationPolicySection: React.FC<NotificationPolicySectionProps> = ({ scope, id, inheritsFrom }) => {
  const [view, setView] = useState<ScopeView | null>(null);
  const [draft, setDraft] = useState<Record<string, PolicyEntry>>({});
  const [mute, setMute] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adopt = useCallback((data: ScopeView) => {
    setView(data);
    setDraft(Object.fromEntries(data.types.map((row) => [row.type, { ...row.own }])));
    setMute(data.mute);
  }, []);

  const load = useCallback(async () => {
    if (scope !== "defaults" && !id) return;
    setError(null);
    try {
      const res = await axios.get(API_URL, { params: { _method: "getNotificationPolicy", scope, id } });
      adopt(res.data?.data);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Не удалось загрузить политику уведомлений");
    }
  }, [scope, id, adopt]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const dirty = useMemo(() => {
    if (!view) return false;
    if (mute !== view.mute) return true;
    return view.types.some((row) => {
      const current = draft[row.type] ?? {};
      return current.push !== row.own.push || current.dashboard !== row.own.dashboard;
    });
  }, [view, draft, mute]);

  const setChannel = (type: string, channel: "push" | "dashboard", value: string) => {
    setDraft((current) => {
      const entry = { ...(current[type] ?? {}) };
      // The empty option is "наследуется": store nothing rather than an explicit value.
      if (value === "") delete entry[channel];
      else (entry as any)[channel] = value;
      return { ...current, [type]: entry };
    });
  };

  const save = useCallback(async (entry: Record<string, unknown> | null) => {
    setBusy(true);
    setError(null);
    try {
      const res = await axios.post(API_URL, { _method: "setNotificationPolicy", scope, id, entry });
      adopt(res.data?.data);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Не удалось сохранить политику уведомлений");
    } finally {
      setBusy(false);
    }
  }, [scope, id, adopt]);

  const saveDraft = () => {
    const entry: Record<string, unknown> = {};
    if (mute) entry.mute = true;
    for (const [type, value] of Object.entries(draft)) {
      const cleaned: PolicyEntry = {};
      if (value.push) cleaned.push = value.push;
      if (value.dashboard) cleaned.dashboard = value.dashboard;
      if (Object.keys(cleaned).length > 0) entry[type] = cleaned;
    }
    // An empty entry is not "everything off" — it is "this scope says nothing", so remove it.
    save(Object.keys(entry).length > 0 ? entry : null);
  };

  return (
    <div className="rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Уведомления</h3>
          <p className="text-xs text-muted-foreground">
            Что доходит до телефона и до колокольчика в панели.
            {inheritsFrom ? ` Что здесь не задано — берётся ${inheritsFrom}.` : ""}
          </p>
        </div>
        <button onClick={() => setOpen((value) => !value)} className="rounded border px-3 py-1.5 text-sm font-medium">
          {open ? "Свернуть" : "Настроить"}
        </button>
      </div>

      {open && (
        <div className="mt-4 space-y-3">
          {error && (
            <div className="rounded border p-2 text-sm" style={{ borderColor: "#fecaca", backgroundColor: "#fef2f2", color: "#b91c1c" }}>
              {error}
            </div>
          )}

          {view?.shadowedByEnvironment && (
            <div className="rounded border p-2 text-xs" style={{ borderColor: "#fde68a", backgroundColor: "#fffbeb", color: "#92400e" }}>
              AGENTIZ_NOTIFY_POLICY задана в окружении и перекрывает сохранённый документ целиком —
              правки отсюда сохранятся, но применяться будет значение из .env.
            </div>
          )}

          {!view && <p className="text-sm text-muted-foreground">Загрузка…</p>}

          {view && (
            <>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={mute} onChange={(event) => setMute(event.target.checked)} />
                Замьютить всё
                <span className="text-xs text-muted-foreground">
                  (кроме типов, для которых ниже выбрано явное значение)
                </span>
              </label>

              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="py-1 font-medium">Событие</th>
                    <th className="py-1 font-medium">Пуш</th>
                    <th className="py-1 font-medium">Колокольчик</th>
                    <th className="py-1 font-medium">Сейчас</th>
                  </tr>
                </thead>
                <tbody>
                  {view.types.map((row) => {
                    const entry = draft[row.type] ?? {};
                    return (
                      <tr key={row.type} className="border-t">
                        <td className="py-1.5 pr-2">
                          <div>{row.label}</div>
                          <div className="text-[11px] text-muted-foreground">{row.type}</div>
                        </td>
                        <td className="py-1.5 pr-2">
                          <select
                            value={entry.push ?? ""}
                            onChange={(event) => setChannel(row.type, "push", event.target.value)}
                            className="rounded border px-2 py-1 text-sm"
                          >
                            <option value="">наследуется ({PUSH_TITLES[row.inherited.push]})</option>
                            <option value="on">будить</option>
                            <option value="silent">тихо</option>
                            <option value="off">не слать</option>
                          </select>
                        </td>
                        <td className="py-1.5 pr-2">
                          <select
                            value={entry.dashboard ?? ""}
                            onChange={(event) => setChannel(row.type, "dashboard", event.target.value)}
                            className="rounded border px-2 py-1 text-sm"
                          >
                            <option value="">наследуется ({DASHBOARD_TITLES[row.inherited.dashboard]})</option>
                            <option value="on">слать</option>
                            <option value="off">не слать</option>
                          </select>
                        </td>
                        <td className="py-1.5 text-xs text-muted-foreground">
                          пуш: {PUSH_TITLES[row.effective.push]} · колокольчик: {DASHBOARD_TITLES[row.effective.dashboard]}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={saveDraft}
                  disabled={busy || !dirty}
                  className="rounded border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                >
                  {busy ? "Сохранение…" : "Сохранить"}
                </button>
                <button
                  onClick={() => adopt(view)}
                  disabled={busy || !dirty}
                  className="rounded border px-3 py-1.5 text-sm disabled:opacity-50"
                >
                  Отменить правки
                </button>
                <button
                  onClick={() => save(null)}
                  disabled={busy}
                  className="rounded border px-3 py-1.5 text-sm disabled:opacity-50"
                >
                  Сбросить к наследованию
                </button>
                <span className="text-xs text-muted-foreground">
                  Лента активностей пишется всегда — политика отключает только доставку.
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default NotificationPolicySection;
