import React, { useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";

const API_URL = `${(window as any).routePrefix ?? "/dashboard"}/agentiz-tasks`;

interface TaskListItem {
  id: string;
  projectId: string;
  externalId: string;
  /** The id the remote system uses; externalId is namespaced per source to avoid collisions. */
  remoteExternalId?: string;
  externalUrl?: string | null;
  title: string;
  status: string;
  priority: string;
  externalStatus?: string | null;
  tags?: string[] | null;
  assigneeId?: number | null;
  sourceType?: string | null;
  sourceTitle?: string;
  sourceName?: string | null;
  sourceAvailable?: boolean;
  commentCount?: number;
  updatedAt?: string;
}

interface TaskComment {
  id: string;
  authorKind: "human" | "agent" | "system";
  /** Where it was written: `remote` means it was pulled from the task's own tracker. */
  origin?: "local" | "remote";
  authorName?: string | null;
  runId?: string | null;
  body: string;
  externalUrl?: string | null;
  /** Upstream timestamp for pulled comments; the thread is ordered by it server-side. */
  externalCreatedAt?: string | null;
  createdAt?: string;
}

interface TaskDetails {
  task: TaskListItem & { description?: string | null; remoteExternalId?: string; canPullComments?: boolean };
  project: { id: string; name: string; slug: string } | null;
  source: { id: string; name: string; type: string; isActive: boolean } | null;
  runs: Array<{ id: string; status: string; trigger: string; triggerCommentId?: string | null; previousRunId?: string | null; createdAt?: string; resultSummary?: string | null; errorMessage?: string | null; commitUrl?: string | null; responseUrl?: string | null }>;
  latestRun: {
    run: { id: string; status: string };
    stages: Array<{ id: string; stageIndex: number; role: string; status: string; errorMessage?: string | null }>;
    logs: Array<{ id: string; level: string; message: string; createdAt?: string }>;
  } | null;
  comments: TaskComment[];
}

interface TaskSource {
  id: string;
  projectId: string;
  name: string;
  type: string;
  typeTitle?: string;
  config?: Record<string, unknown> | null;
  secrets?: Record<string, string> | null;
  isActive: boolean;
  syncComments?: boolean;
  available?: boolean;
  lastSyncedAt?: string | null;
  lastError?: string | null;
}

interface TaskManagerDescriptor {
  type: string;
  title: string;
  description: string | null;
  supportsWriteback: boolean;
  supportsComments: boolean;
  configFields: Array<{ key: string; title: string; kind: "text" | "secret"; required?: boolean; placeholder?: string; hint?: string }>;
}

interface FilterOptions {
  statuses: string[];
  priorities: string[];
  projects: Array<{ id: string; name: string; slug: string }>;
  sourceTypes: Array<{ type: string; title: string; available: boolean }>;
}

/**
 * Colours are inline styles, not Tailwind palette classes.
 *
 * Adminizer serves a prebuilt, restricted Tailwind bundle: `bg-emerald-100`, `text-sky-700`,
 * `border-l-4`, `ml-3` and friends are simply absent from it, so a class-based palette silently
 * renders as flat grey text. Inline styles do not depend on what someone else's build happened to
 * include. (Layout utilities — flex, gap-*, p-*, rounded, text-xs — are present and still used.)
 */
type Swatch = { bg: string; fg: string };

const NEUTRAL: Swatch = { bg: "#f1f5f9", fg: "#334155" };

const STATUS_COLORS: Record<string, Swatch> = {
  new: { bg: "#f1f5f9", fg: "#334155" },
  queued: { bg: "#dbeafe", fg: "#1d4ed8" },
  running: { bg: "#fef3c7", fg: "#b45309" },
  waiting_review: { bg: "#ede9fe", fg: "#6d28d9" },
  done: { bg: "#d1fae5", fg: "#047857" },
  succeeded: { bg: "#d1fae5", fg: "#047857" },
  failed: { bg: "#fee2e2", fg: "#b91c1c" },
  cancelled: { bg: "#f1f5f9", fg: "#64748b" },
  ignored: { bg: "#f1f5f9", fg: "#64748b" },
  pending: { bg: "#f1f5f9", fg: "#475569" },
};

const PRIORITY_COLORS: Record<string, Swatch> = {
  low: { bg: "#f1f5f9", fg: "#64748b" },
  normal: { bg: "#e0f2fe", fg: "#0369a1" },
  high: { bg: "#ffedd5", fg: "#c2410c" },
  urgent: { bg: "#fee2e2", fg: "#b91c1c" },
};

/** Who wrote a comment — the left rail colour is what makes the thread scannable. */
const AUTHOR_STYLES: Record<string, { label: string; rail: string; bg: string }> = {
  human: { label: "человек", rail: "#38bdf8", bg: "#f0f9ff" },
  agent: { label: "агент", rail: "#a78bfa", bg: "#f5f3ff" },
  system: { label: "система", rail: "#cbd5e1", bg: "#f8fafc" },
};

const Badge: React.FC<{ text: string; palette?: Record<string, Swatch> }> = ({ text, palette }) => {
  const swatch = palette?.[text] ?? NEUTRAL;
  return (
    <span
      className="inline-block rounded px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: swatch.bg, color: swatch.fg }}
    >
      {text}
    </span>
  );
};

const AgentizTasks: React.FC = () => {
  const [filters, setFilters] = useState<FilterOptions | null>(null);
  const [tasks, setTasks] = useState<TaskListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [details, setDetails] = useState<TaskDetails | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [sources, setSources] = useState<TaskSource[]>([]);
  const [managers, setManagers] = useState<TaskManagerDescriptor[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [showSources, setShowSources] = useState(false);
  const [showNewTask, setShowNewTask] = useState(false);

  const [query, setQuery] = useState(() => ({
    projectId: new URLSearchParams(window.location.search).get("projectId") ?? "",
    status: "",
    priority: "",
    sourceType: "",
    search: "",
  }));

  // --- new source form -----------------------------------------------------------------------
  const [newSource, setNewSource] = useState<{ projectId: string; type: string; name: string; values: Record<string, string> }>({
    projectId: "",
    type: "",
    name: "",
    values: {},
  });
  const selectedManager = useMemo(
    () => managers.find((m) => m.type === newSource.type) ?? null,
    [managers, newSource.type],
  );

  // --- new task form -------------------------------------------------------------------------
  const [newTask, setNewTask] = useState({ projectId: "", title: "", description: "", priority: "normal" });

  const fail = (e: any, fallback: string) => setError(e?.response?.data?.message ?? fallback);

  const loadFilters = useCallback(async () => {
    try {
      const res = await axios.get(API_URL, { params: { _method: "getFilters" } });
      setFilters(res.data?.data ?? null);
    } catch (e: any) {
      fail(e, "Не удалось загрузить фильтры");
    }
  }, []);

  const loadManagers = useCallback(async () => {
    try {
      const res = await axios.get(API_URL, { params: { _method: "getTaskManagers" } });
      setManagers(res.data?.data ?? []);
    } catch (e: any) {
      fail(e, "Не удалось загрузить список таск-менеджеров");
    }
  }, []);

  const loadSources = useCallback(async () => {
    try {
      const res = await axios.get(API_URL, { params: { _method: "getSources" } });
      setSources(res.data?.data ?? []);
    } catch (e: any) {
      fail(e, "Не удалось загрузить источники задач");
    }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const res = await axios.get(API_URL, { params: { _method: "getTasks", ...query } });
      setTasks(res.data?.data ?? []);
      setTotal(res.data?.meta?.total ?? 0);
    } catch (e: any) {
      fail(e, "Не удалось загрузить задачи");
    }
  }, [query]);

  const loadDetails = useCallback(async (taskId: string) => {
    if (!taskId) {
      setDetails(null);
      return;
    }
    try {
      const res = await axios.get(API_URL, { params: { _method: "getTask", taskId } });
      setDetails(res.data?.data ?? null);
    } catch (e: any) {
      fail(e, "Не удалось загрузить задачу");
    }
  }, []);

  useEffect(() => {
    loadFilters();
    loadManagers();
    loadSources();
  }, [loadFilters, loadManagers, loadSources]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    loadDetails(selectedId);
  }, [selectedId, loadDetails]);

  const post = useCallback(
    async (payload: Record<string, unknown>, successNotice?: string) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const res = await axios.post(API_URL, payload);
        if (successNotice) setNotice(successNotice);
        return res.data?.data;
      } catch (e: any) {
        fail(e, "Действие не выполнено");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const patchTask = useCallback(
    async (taskId: string, patch: Record<string, unknown>) => {
      const result = await post({ _method: "updateTask", taskId, ...patch });
      if (result) {
        await loadTasks();
        await loadDetails(taskId);
      }
    },
    [post, loadTasks, loadDetails],
  );

  const submitComment = useCallback(async () => {
    if (!selectedId || !commentDraft.trim()) return;
    const result = await post({ _method: "addComment", taskId: selectedId, body: commentDraft });
    if (result) {
      setCommentDraft("");
      await loadDetails(selectedId);
      await loadTasks();
    }
  }, [selectedId, commentDraft, post, loadDetails, loadTasks]);

  const pullComments = useCallback(
    async (taskId: string) => {
      const result = await post({ _method: "pullComments", taskId });
      if (result) {
        setNotice(
          result.created > 0 || result.updated > 0
            ? `Из трекера: ${result.fetched}, новых ${result.created}, обновлено ${result.updated}`
            : `Из трекера: ${result.fetched}, всё уже было загружено`,
        );
        await loadDetails(taskId);
        await loadTasks();
      }
    },
    [post, loadDetails, loadTasks],
  );

  const runPipeline = useCallback(
    async (taskId: string) => {
      const result = await post({ _method: "runTask", taskId }, "Пайплайн запущен");
      if (result) {
        await loadTasks();
        await loadDetails(taskId);
      }
    },
    [post, loadTasks, loadDetails],
  );

  const createSource = useCallback(async () => {
    if (!newSource.projectId || !newSource.type || !newSource.name) {
      setError("Заполните проект, тип и название источника");
      return;
    }
    const result = await post(
      { _method: "createSource", ...newSource, isActive: true },
      "Источник задач добавлен",
    );
    if (result) {
      setNewSource({ projectId: newSource.projectId, type: "", name: "", values: {} });
      await loadSources();
      await loadFilters();
    }
  }, [newSource, post, loadSources, loadFilters]);

  const syncSource = useCallback(
    async (sourceId: string) => {
      const result = await post({ _method: "syncSource", sourceId });
      if (result) {
        setNotice(
          `Загружено: ${result.fetched}, создано: ${result.created}, обновлено: ${result.updated}` +
            (result.errors?.length ? `, ошибок: ${result.errors.length}` : ""),
        );
        await loadSources();
        await loadTasks();
        await loadFilters();
      }
    },
    [post, loadSources, loadTasks, loadFilters],
  );

  const createTask = useCallback(async () => {
    if (!newTask.projectId || !newTask.title.trim()) {
      setError("Выберите проект и укажите заголовок");
      return;
    }
    const result = await post({ _method: "createTask", ...newTask }, "Задача создана");
    if (result) {
      setNewTask({ projectId: newTask.projectId, title: "", description: "", priority: "normal" });
      setShowNewTask(false);
      await loadTasks();
      setSelectedId(result.id);
    }
  }, [newTask, post, loadTasks]);

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Задачи Agentiz</h1>
          <p className="text-sm text-muted-foreground">
            Единый трекер: задачи из подключённых таск-менеджеров и созданные вручную, с обсуждением
            от людей и от агентов.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowNewTask((v) => !v)} className="rounded border px-3 py-1.5 text-sm font-medium">
            Новая задача
          </button>
          <button onClick={() => setShowSources((v) => !v)} className="rounded border px-3 py-1.5 text-sm font-medium">
            Источники задач ({sources.length})
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded border p-3 text-sm" style={{ borderColor: "#fecaca", backgroundColor: "#fef2f2", color: "#b91c1c" }}>
          <span>{error}</span>
          <button onClick={() => setError(null)} className="underline" style={{ marginLeft: 12 }}>
            скрыть
          </button>
        </div>
      )}
      {notice && (
        <div className="rounded border p-3 text-sm" style={{ borderColor: "#a7f3d0", backgroundColor: "#ecfdf5", color: "#065f46" }}>
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="underline" style={{ marginLeft: 12 }}>
            скрыть
          </button>
        </div>
      )}

      {showNewTask && (
        <div className="rounded-lg border p-4">
          <h2 className="mb-3 text-lg font-semibold">Новая задача</h2>
          <div className="grid gap-2 md:grid-cols-4">
            <select
              value={newTask.projectId}
              onChange={(e) => setNewTask({ ...newTask, projectId: e.target.value })}
              className="rounded border px-2 py-1.5 text-sm"
            >
              <option value="">Проект…</option>
              {(filters?.projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              value={newTask.title}
              onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
              placeholder="Заголовок"
              className="rounded border px-2 py-1.5 text-sm md:col-span-2"
            />
            <select
              value={newTask.priority}
              onChange={(e) => setNewTask({ ...newTask, priority: e.target.value })}
              className="rounded border px-2 py-1.5 text-sm"
            >
              {(filters?.priorities ?? ["low", "normal", "high", "urgent"]).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <textarea
            value={newTask.description}
            onChange={(e) => setNewTask({ ...newTask, description: e.target.value })}
            placeholder="Описание"
            rows={3}
            className="mt-2 w-full rounded border px-2 py-1.5 text-sm"
          />
          <button
            onClick={createTask}
            disabled={busy}
            className="mt-2 rounded border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            Создать
          </button>
        </div>
      )}

      {showSources && (
        <div className="rounded-lg border p-4">
          <h2 className="mb-1 text-lg font-semibold">Источники задач</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Каждый источник — один удалённый таск-менеджер. Доступные типы приходят из коллекции
            <code className="mx-1 rounded px-1" style={{ backgroundColor: "#f1f5f9" }}>taskManagers</code>: подключите слой
            интеграции — и его система появится в списке.
          </p>

          {sources.length === 0 && (
            <p className="mb-3 text-sm text-muted-foreground">Источников пока нет.</p>
          )}
          <ul className="mb-4 space-y-2">
            {sources.map((source) => (
              <li key={source.id} className="rounded border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{source.name}</span>
                  <Badge text={source.typeTitle ?? source.type} />
                  {!source.isActive && <Badge text="выключен" palette={STATUS_COLORS} />}
                  {source.available === false && (
                    <span className="rounded px-2 py-0.5 text-xs" style={{ backgroundColor: "#fee2e2", color: "#b91c1c" }}>
                      слой адаптера не смонтирован
                    </span>
                  )}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Последняя синхронизация: {source.lastSyncedAt ?? "никогда"}
                  {source.lastError ? ` · ошибка: ${source.lastError}` : ""}
                </div>
                {/* Off by default: one extra API call per task the sync touched. */}
                <label className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={Boolean(source.syncComments)}
                    disabled={busy}
                    onChange={async (event) => {
                      const r = await post({
                        _method: "updateSource",
                        sourceId: source.id,
                        syncComments: event.target.checked,
                      });
                      if (r) await loadSources();
                    }}
                  />
                  Тянуть обсуждение при синхронизации
                </label>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    onClick={() => syncSource(source.id)}
                    disabled={busy}
                    className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                  >
                    Синхронизировать
                  </button>
                  <button
                    onClick={async () => {
                      const r = await post({ _method: "testSource", sourceId: source.id });
                      if (r) setNotice(r.ok ? "Подключение работает" : "Подключение не удалось");
                    }}
                    disabled={busy}
                    className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                  >
                    Проверить
                  </button>
                  <button
                    onClick={async () => {
                      const r = await post({
                        _method: "updateSource",
                        sourceId: source.id,
                        isActive: !source.isActive,
                      });
                      if (r) await loadSources();
                    }}
                    disabled={busy}
                    className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                  >
                    {source.isActive ? "Выключить" : "Включить"}
                  </button>
                  <button
                    onClick={async () => {
                      if (!window.confirm(`Удалить источник «${source.name}»? Уже загруженные задачи останутся.`)) return;
                      const r = await post({ _method: "deleteSource", sourceId: source.id });
                      if (r) await loadSources();
                    }}
                    disabled={busy}
                    className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50" style={{ borderColor: "#fca5a5", color: "#b91c1c" }}
                  >
                    Удалить
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <div className="rounded border border-dashed p-3">
            <h3 className="mb-2 text-sm font-semibold">Добавить источник</h3>
            <div className="grid gap-2 md:grid-cols-3">
              <select
                value={newSource.projectId}
                onChange={(e) => setNewSource({ ...newSource, projectId: e.target.value })}
                className="rounded border px-2 py-1.5 text-sm"
              >
                <option value="">Проект…</option>
                {(filters?.projects ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <select
                value={newSource.type}
                onChange={(e) => setNewSource({ ...newSource, type: e.target.value, values: {} })}
                className="rounded border px-2 py-1.5 text-sm"
              >
                <option value="">Таск-менеджер…</option>
                {managers.map((m) => (
                  <option key={m.type} value={m.type}>
                    {m.title}
                  </option>
                ))}
              </select>
              <input
                value={newSource.name}
                onChange={(e) => setNewSource({ ...newSource, name: e.target.value })}
                placeholder="Название источника"
                className="rounded border px-2 py-1.5 text-sm"
              />
            </div>

            {selectedManager && (
              <>
                {selectedManager.description && (
                  <p className="mt-2 text-xs text-muted-foreground">{selectedManager.description}</p>
                )}
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  {selectedManager.configFields.map((field) => (
                    <label key={field.key} className="text-xs">
                      <span className="block text-muted-foreground">
                        {field.title}
                        {field.required ? " *" : ""}
                      </span>
                      <input
                        type={field.kind === "secret" ? "password" : "text"}
                        value={newSource.values[field.key] ?? ""}
                        placeholder={field.placeholder}
                        onChange={(e) =>
                          setNewSource({
                            ...newSource,
                            values: { ...newSource.values, [field.key]: e.target.value },
                          })
                        }
                        className="mt-0.5 w-full rounded border px-2 py-1.5 text-sm"
                      />
                      {field.hint && <span className="text-[11px] text-muted-foreground">{field.hint}</span>}
                    </label>
                  ))}
                </div>
              </>
            )}

            <button
              onClick={createSource}
              disabled={busy}
              className="mt-3 rounded border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            >
              Добавить источник
            </button>
          </div>
        </div>
      )}

      <div className="rounded-lg border p-3">
        <div className="grid gap-2 md:grid-cols-5">
          <select
            value={query.projectId}
            onChange={(e) => setQuery({ ...query, projectId: e.target.value })}
            className="rounded border px-2 py-1.5 text-sm"
          >
            <option value="">Все проекты</option>
            {(filters?.projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            value={query.status}
            onChange={(e) => setQuery({ ...query, status: e.target.value })}
            className="rounded border px-2 py-1.5 text-sm"
          >
            <option value="">Любой статус</option>
            {(filters?.statuses ?? []).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            value={query.priority}
            onChange={(e) => setQuery({ ...query, priority: e.target.value })}
            className="rounded border px-2 py-1.5 text-sm"
          >
            <option value="">Любой приоритет</option>
            {(filters?.priorities ?? []).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select
            value={query.sourceType}
            onChange={(e) => setQuery({ ...query, sourceType: e.target.value })}
            className="rounded border px-2 py-1.5 text-sm"
          >
            <option value="">Любой таск-менеджер</option>
            {(filters?.sourceTypes ?? []).map((s) => (
              <option key={s.type} value={s.type}>
                {s.title}
                {s.available ? "" : " (нет адаптера)"}
              </option>
            ))}
          </select>
          <input
            value={query.search}
            onChange={(e) => setQuery({ ...query, search: e.target.value })}
            placeholder="Поиск по заголовку…"
            className="rounded border px-2 py-1.5 text-sm"
          />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="rounded-lg border p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Задачи</h2>
            <span className="text-xs text-muted-foreground">показано {tasks.length} из {total}</span>
          </div>
          {tasks.length === 0 && <p className="text-sm text-muted-foreground">Ничего не найдено.</p>}
          <ul className="space-y-2">
            {tasks.map((task) => (
              <li
                key={task.id}
                onClick={() => setSelectedId(task.id)}
                className={`cursor-pointer rounded border p-3 ${task.id === selectedId ? "border-primary bg-primary/5" : ""}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge text={task.status} palette={STATUS_COLORS} />
                  <Badge text={task.priority} palette={PRIORITY_COLORS} />
                  <span className="font-medium">{task.title}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {/* Where this task came from — the whole point of the taskManagers collection. */}
                  <span
                    className="rounded px-1.5 py-0.5"
                    style={{ backgroundColor: "#eef2ff", color: "#4338ca" }}
                    title={task.sourceName ?? undefined}
                  >
                    {task.sourceTitle ?? task.sourceType ?? "вручную"}
                  </span>
                  {/* A locally created task has no number in any remote system — showing the
                      synthetic `local:…` id would be noise. */}
                  {task.sourceType !== "local" && <span>#{task.remoteExternalId ?? task.externalId}</span>}
                  {task.externalStatus && <span>· трекер: {task.externalStatus}</span>}
                  {(task.commentCount ?? 0) > 0 && <span>· 💬 {task.commentCount}</span>}
                  {(task.tags ?? []).map((tag) => (
                    <span key={tag} className="rounded px-1.5 py-0.5" style={{ backgroundColor: "#f1f5f9", color: "#475569" }}>
                      {tag}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-lg border p-4">
          {!details && <p className="text-sm text-muted-foreground">Выберите задачу слева.</p>}
          {details && (
            <div className="space-y-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge text={details.task.status} palette={STATUS_COLORS} />
                  <Badge text={details.task.priority} palette={PRIORITY_COLORS} />
                  <h2 className="text-lg font-semibold">{details.task.title}</h2>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {details.project?.name ?? "—"} · источник:{" "}
                  {details.task.sourceName ?? details.task.sourceTitle ?? "вручную"}
                  {details.task.sourceAvailable === false && (
                    <span style={{ marginLeft: 4, color: "#dc2626" }}>(адаптер недоступен)</span>
                  )}
                  {details.task.externalUrl && (
                    <>
                      {" · "}
                      <a href={details.task.externalUrl} target="_blank" rel="noreferrer" className="underline">
                        открыть в трекере
                      </a>
                    </>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={details.task.status}
                  disabled={busy}
                  onChange={(e) => patchTask(details.task.id, { status: e.target.value })}
                  className="rounded border px-2 py-1 text-xs"
                >
                  {(filters?.statuses ?? []).map((s) => (
                    <option key={s} value={s}>
                      статус: {s}
                    </option>
                  ))}
                </select>
                <select
                  value={details.task.priority}
                  disabled={busy}
                  onChange={(e) => patchTask(details.task.id, { priority: e.target.value })}
                  className="rounded border px-2 py-1 text-xs"
                >
                  {(filters?.priorities ?? []).map((p) => (
                    <option key={p} value={p}>
                      приоритет: {p}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => runPipeline(details.task.id)}
                  disabled={busy}
                  className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                >
                  Запустить пайплайн
                </button>
              </div>

              {details.task.description && (
                <pre className="whitespace-pre-wrap rounded p-3 text-xs" style={{ backgroundColor: "#f8fafc" }}>{details.task.description}</pre>
              )}

              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">Обсуждение</h3>
                  {/* Only offered when the task's origin can actually hand us its thread. */}
                  {details.task.canPullComments && (
                    <button
                      onClick={() => pullComments(details.task.id)}
                      disabled={busy}
                      className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                    >
                      Подтянуть из трекера
                    </button>
                  )}
                </div>
                {details.comments.length === 0 && (
                  <p className="text-xs text-muted-foreground">Комментариев пока нет.</p>
                )}
                <ul className="space-y-2">
                  {details.comments.map((comment) => {
                    const style = AUTHOR_STYLES[comment.authorKind] ?? AUTHOR_STYLES.system;
                    return (
                      <li
                        key={comment.id}
                        className="rounded p-3"
                        style={{ borderLeft: `4px solid ${style.rail}`, backgroundColor: style.bg }}
                      >
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span className="font-medium text-slate-700">{comment.authorName ?? style.label}</span>
                          <span className="rounded px-1.5 py-0.5" style={{ backgroundColor: "rgba(255,255,255,0.7)" }}>{style.label}</span>
                          {/* Who wrote it and where it was written are different facts. */}
                          {comment.origin === "remote" && (
                            <span className="rounded px-1.5 py-0.5" style={{ backgroundColor: "#fef3c7", color: "#92400e" }}>из трекера</span>
                          )}
                          <span>{comment.externalCreatedAt ?? comment.createdAt}</span>
                          {comment.externalUrl && (
                            <a href={comment.externalUrl} target="_blank" rel="noreferrer" className="underline">
                              {comment.origin === "remote" ? "открыть в трекере" : "опубликован в трекере"}
                            </a>
                          )}
                        </div>
                        <pre className="mt-1 whitespace-pre-wrap text-sm">{comment.body}</pre>
                        <div className="mt-1 flex gap-2">
                          {/* Bookkeeping entries are ours alone, and a comment that came from the
                              tracker is already there — neither has anything to push. */}
                          {comment.authorKind !== "system" &&
                            comment.origin !== "remote" &&
                            !comment.externalUrl &&
                            details.task.externalUrl && (
                            <button
                              onClick={async () => {
                                const r = await post({ _method: "publishComment", commentId: comment.id });
                                if (r) await loadDetails(details.task.id);
                              }}
                              disabled={busy}
                              className="text-xs underline disabled:opacity-50"
                            >
                              отправить в трекер
                            </button>
                          )}
                          <button
                            onClick={async () => {
                              if (!window.confirm("Удалить комментарий?")) return;
                              const r = await post({ _method: "deleteComment", commentId: comment.id });
                              if (r) await loadDetails(details.task.id);
                            }}
                            disabled={busy}
                            className="text-xs underline disabled:opacity-50"
                          >
                            удалить
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>

                <textarea
                  value={commentDraft}
                  onChange={(e) => setCommentDraft(e.target.value)}
                  placeholder="Написать комментарий…"
                  rows={3}
                  className="mt-3 w-full rounded border px-2 py-1.5 text-sm"
                />
                <button
                  onClick={submitComment}
                  disabled={busy || !commentDraft.trim()}
                  className="mt-1 rounded border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                >
                  Добавить комментарий
                </button>
              </div>

              {details.runs.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold">Запуски</h3>
                  <ul className="space-y-2">
                    {details.runs.map((run) => (
                      <li key={run.id} className="rounded border p-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge text={run.status} palette={STATUS_COLORS} />
                          <span className="text-muted-foreground">
                            {run.trigger} · {run.createdAt}
                          </span>
                          {run.triggerCommentId && <span className="text-muted-foreground">после сообщения {run.triggerCommentId.slice(0, 8)}</span>}
                          {run.previousRunId && <span className="text-muted-foreground">после запуска {run.previousRunId.slice(0, 8)}</span>}
                          <a href={`${(window as any).routePrefix ?? "/dashboard"}/agentiz-runs?runId=${run.id}`} className="underline">
                            подробнее
                          </a>
                          {run.status !== "succeeded" && run.status !== "failed" && run.status !== "cancelled" && (
                            <button
                              onClick={async () => {
                                const r = await post({ _method: "cancelRun", runId: run.id });
                                if (r) await loadDetails(details.task.id);
                              }}
                              disabled={busy}
                              className="underline disabled:opacity-50"
                            >
                              отменить
                            </button>
                          )}
                        </div>
                        {run.errorMessage && <div className="mt-1" style={{ color: "#dc2626" }}>{run.errorMessage}</div>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {details.latestRun && details.latestRun.logs.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold">Логи последнего запуска</h3>
                  <div className="overflow-auto rounded p-2 font-mono text-[11px]" style={{ maxHeight: 256, backgroundColor: "#0f172a", color: "#e2e8f0" }}>
                    {details.latestRun.logs.map((log) => (
                      <div key={log.id}>
                        <span style={{ color: "#94a3b8" }}>[{log.level}]</span> {log.message}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AgentizTasks;
