import React, { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { formatDateTime, remainingSuffix, useViewerTimezone } from "./lib/viewerTime";

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
  git?: { pushEnabled: boolean; remote?: string };
}

interface WorkerExecutor {
  key: string;
  title?: string;
  acpCommand: string[];
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
  gitPushRoots?: string[] | null;
  manualExecutors?: WorkerExecutor[] | null;
  maxConcurrentJobs?: number | null;
  activeHours?: unknown;
  timezone?: string | null;
}

interface RepositoryOption {
  id: string;
  provider: string;
  pathWithNamespace: string;
  connectionId: string;
}

interface HarnessWindowState {
  key: string;
  label?: string;
  usedPercent?: number;
  resetsAt?: string | null;
  observedAt?: string;
  source?: string;
}

interface HarnessSubscription {
  id: string;
  name: string;
  provider: string;
  authKind?: string | null;
  accountId?: string | null;
  resetSchedule?: unknown;
  stopPolicy?: unknown;
  windows: HarnessWindowState[];
  exhaustedUntil?: string | null;
  exhaustedReason?: string | null;
  exhausted: boolean;
  lastSignalAt?: string | null;
  lastSignalSource?: string | null;
}

interface WorkerHarnessBinding {
  id: string;
  harnessKey: string;
  enabled: boolean;
  maxConcurrent?: number | null;
  subscription: HarnessSubscription | null;
  state: "disabled" | "exhausted" | "available";
  latestSample: {
    observedAt: string;
    source: string;
    windows: HarnessWindowState[];
    meta?: unknown;
    accountId?: string | null;
  } | null;
  accountMismatch: boolean;
  runningJobs: number;
  queuedJobs: number;
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
  return `не в сети (последний раз ${formatDateTime(worker.lastSeenAt)})`;
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
  const [pushEnabled, setPushEnabled] = useState(false);
  const [remote, setRemote] = useState("origin");
  const workspaces = worker.workspaces ?? [];

  const add = () => {
    const trimmedKey = key.trim();
    const trimmedPath = path.trim();
    if (!trimmedKey || !trimmedPath) return;
    onSave([...workspaces.filter((item) => item.key !== trimmedKey), {
      key: trimmedKey, path: trimmedPath,
      ...(pushEnabled ? { git: { pushEnabled: true, remote: remote.trim() || "origin" } } : {}),
    }]);
    setKey("");
    setPath("");
    setPushEnabled(false);
    setRemote("origin");
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
              {workspace.git?.pushEnabled && <span style={{ color: "#047857" }}>Git push: {workspace.git.remote ?? "origin"}</span>}
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
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={pushEnabled} onChange={(event) => setPushEnabled(event.target.checked)} />
          Разрешить Git push
        </label>
        {pushEnabled && <input value={remote} onChange={(event) => setRemote(event.target.value)} placeholder="origin" className="w-24 rounded border px-2 py-1 text-xs" />}
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

/**
 * Where on this machine a pipeline is allowed to push from.
 *
 * Separate from the folder list on purpose: a pipeline can name any absolute path by itself, so this
 * is the only setting an operator has to touch to enable Git review, and the only one that cannot be
 * granted from a pipeline spec.
 */
const WorkerGitPushRootsEditor: React.FC<{
  worker: AgentWorker;
  busy: boolean;
  onSave: (roots: string[]) => void;
}> = ({ worker, busy, onSave }) => {
  const [root, setRoot] = useState("");
  const roots = worker.gitPushRoots ?? [];
  const draft = root.trim();

  return (
    <div className="mt-2 rounded border p-2">
      <div className="text-xs font-medium">Откуда разрешён Git push</div>
      {roots.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Пока ниоткуда. Пайплайны могут работать в папках этой машины, но коммитить и пушить из них не смогут.
        </p>
      ) : (
        <ul className="mt-1 space-y-1">
          {roots.map((item) => (
            <li key={item} className="flex flex-wrap items-center gap-2 text-xs">
              <code className="rounded border px-1">{item}</code>
              <span className="text-muted-foreground">и всё, что внутри</span>
              <button
                onClick={() => onSave(roots.filter((existing) => existing !== item))}
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
          value={root}
          onChange={(event) => setRoot(event.target.value)}
          placeholder="/srv/projects"
          className="w-64 rounded border px-2 py-1 text-xs"
        />
        <button
          onClick={() => {
            if (!draft) return;
            onSave(Array.from(new Set([...roots, draft])));
            setRoot("");
          }}
          disabled={busy || !draft.startsWith("/") || draft === "/"}
          className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
        >
          Разрешить push
        </button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Путь абсолютный; разрешение действует на саму папку и на все вложенные. Это доверие к машине, а не к пайплайну:
        push делается git-кредами этого хоста, поэтому спека сама себе такое право выдать не может. `/` не принимается.
        Push идёт в remote `origin` — другой remote можно указать только для папки, объявленной по ключу.
      </p>
    </div>
  );
};

const EXECUTOR_PRESETS: Record<"claude" | "codex", WorkerExecutor> = {
  claude: { key: "claude", title: "Claude", acpCommand: ["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.66.0"] },
  codex: { key: "codex", title: "Codex", acpCommand: ["npx", "-y", "@agentclientprotocol/codex-acp@1.1.14"] },
};

/** The manual-launch picker deliberately exposes only safe named profiles, not a command input. */
const WorkerExecutorsEditor: React.FC<{
  worker: AgentWorker;
  busy: boolean;
  onSave: (executors: WorkerExecutor[]) => void;
}> = ({ worker, busy, onSave }) => {
  const executors = worker.manualExecutors ?? [];
  const add = (preset: WorkerExecutor) => onSave([
    ...executors.filter((item) => item.key !== preset.key),
    preset,
  ]);
  return (
    <div className="mt-2 rounded border p-2">
      <div className="text-xs font-medium">Исполнители для ручного запуска</div>
      {executors.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">Не настроены: ручной запуск использует исполнителя, заданного в пайплайне.</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {executors.map((executor) => (
            <li key={executor.key} className="flex flex-wrap items-center gap-2 text-xs">
              <strong>{executor.title || executor.key}</strong>
              <code className="rounded border px-1">{executor.key}</code>
              <button onClick={() => onSave(executors.filter((item) => item.key !== executor.key))} disabled={busy} className="rounded border px-1.5 py-0.5 disabled:opacity-50" style={{ borderColor: "#fca5a5", color: "#b91c1c" }}>Убрать</button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <button onClick={() => add(EXECUTOR_PRESETS.claude)} disabled={busy} className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50">Добавить Claude</button>
        <button onClick={() => add(EXECUTOR_PRESETS.codex)} disabled={busy} className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50">Добавить Codex</button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">При ручном запуске выбранный профиль закрепляет job за этой машиной. Команда ACP хранится в профиле воркера, а не передаётся из задачи.</p>
    </div>
  );
};

function windowsSummary(windows: HarnessWindowState[]): string {
  if (!windows.length) return "телеметрии пока нет";
  return windows
    .map((window) => {
      const used = typeof window.usedPercent === "number" ? `${Math.round(window.usedPercent)}%` : "—";
      const resets = window.resetsAt ? `, сброс ${formatDateTime(window.resetsAt)}${remainingSuffix(window.resetsAt)}` : "";
      return `${window.label ?? window.key}: ${used}${resets}`;
    })
    .join(" · ");
}

const HARNESS_STATE_LABELS: Record<WorkerHarnessBinding["state"], { text: string; color: string }> = {
  available: { text: "🟢 доступен", color: "#047857" },
  exhausted: { text: "🔴 исчерпан", color: "#b91c1c" },
  disabled: { text: "⏸ выключен оператором", color: "#b45309" },
};

/**
 * The "Harness и лимиты" block of one worker: which LLM runners live on this machine, under
 * which subscription, whether the queue gate is open, and the last usage snapshot. Rendering is
 * generic on purpose — abstract windows plus opaque provider meta — so a new harness needs no new
 * display code.
 */
const WorkerHarnessEditor: React.FC<{
  worker: AgentWorker;
  bindings: WorkerHarnessBinding[];
  subscriptions: HarnessSubscription[];
  busy: boolean;
  onAction: (method: string, extra: Record<string, unknown>) => void;
}> = ({ worker, bindings, subscriptions, busy, onAction }) => {
  const [newKey, setNewKey] = useState("");
  const [metaOpen, setMetaOpen] = useState<string | null>(null);

  const replaceBindings = (next: Array<Partial<WorkerHarnessBinding> & { harnessKey: string; subscriptionId?: string | null }>) =>
    onAction("setWorkerHarnessBindings", {
      workerId: worker.id,
      harnessBindings: next.map((binding) => ({
        harnessKey: binding.harnessKey,
        subscriptionId: binding.subscriptionId !== undefined ? binding.subscriptionId : binding.subscription?.id ?? null,
        enabled: binding.enabled !== false,
        maxConcurrent: binding.maxConcurrent ?? null,
      })),
    });

  return (
    <div className="mt-2 rounded border p-2">
      <div className="text-xs font-medium">Harness и лимиты</div>
      {bindings.length === 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          Привязок нет. Добавьте ключ harness'а (например <code>claude</code>) — сервер также создаст привязку сам при первом сигнале о лимите.
        </p>
      )}
      <ul className="mt-1 space-y-2">
        {bindings.map((binding) => {
          const state = HARNESS_STATE_LABELS[binding.state];
          const subscription = binding.subscription;
          return (
            <li key={binding.harnessKey} className="rounded border p-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <code className="rounded border px-1 font-medium">{binding.harnessKey}</code>
                <span style={{ color: state.color }}>
                  {state.text}
                  {binding.state === "exhausted" && subscription?.exhaustedUntil
                    ? ` до ${formatDateTime(subscription.exhaustedUntil)}${remainingSuffix(subscription.exhaustedUntil)} (${subscription.lastSignalSource ?? "?"})`
                    : ""}
                </span>
                <span className="text-muted-foreground">running: {binding.runningJobs} · в очереди: {binding.queuedJobs}</span>
              </div>
              <div className="mt-1 text-muted-foreground">{windowsSummary(subscription?.windows ?? [])}</div>
              {subscription?.exhaustedReason && (
                <div className="mt-1 text-muted-foreground">последний сигнал: {subscription.exhaustedReason.slice(0, 200)}</div>
              )}
              {binding.accountMismatch && (
                <div className="mt-1" style={{ color: "#b45309" }}>
                  ⚠ аккаунт в телеметрии этого воркера не совпадает с аккаунтом подписки — возможно, машина залогинена не туда.
                </div>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <select
                  value={subscription?.id ?? ""}
                  disabled={busy}
                  onChange={(event) =>
                    replaceBindings(bindings.map((item) =>
                      item.harnessKey === binding.harnessKey ? { ...item, subscriptionId: event.target.value || null } : item))}
                  className="rounded border px-2 py-1"
                >
                  <option value="">без подписки (создастся автоматически)</option>
                  {subscriptions.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
                <button
                  onClick={() =>
                    replaceBindings(bindings.map((item) =>
                      item.harnessKey === binding.harnessKey ? { ...item, enabled: !binding.enabled } : item))}
                  disabled={busy}
                  className="rounded border px-2 py-1 disabled:opacity-50"
                >
                  {binding.enabled ? "Выключить" : "Включить"}
                </button>
                <button
                  onClick={() => {
                    const until = window.prompt("Исчерпан до (ISO или ГГГГ-ММ-ДД ЧЧ:ММ):", "");
                    if (!until) return;
                    onAction("markHarnessExhausted", { workerId: worker.id, harnessKey: binding.harnessKey, until, reason: "отмечено вручную из панели" });
                  }}
                  disabled={busy}
                  className="rounded border px-2 py-1 disabled:opacity-50"
                >
                  Отметить исчерпанным…
                </button>
                {binding.state === "exhausted" && (
                  <button
                    onClick={() => onAction("clearHarnessLimit", { workerId: worker.id, harnessKey: binding.harnessKey })}
                    disabled={busy}
                    className="rounded border px-2 py-1 disabled:opacity-50"
                    style={{ borderColor: "#6ee7b7", color: "#047857" }}
                  >
                    Снять лимит
                  </button>
                )}
                {binding.latestSample?.meta != null && (
                  <button
                    onClick={() => setMetaOpen(metaOpen === binding.harnessKey ? null : binding.harnessKey)}
                    disabled={busy}
                    className="rounded border px-2 py-1 disabled:opacity-50"
                  >
                    {metaOpen === binding.harnessKey ? "Скрыть meta" : "Показать meta"}
                  </button>
                )}
                <button
                  onClick={() => replaceBindings(bindings.filter((item) => item.harnessKey !== binding.harnessKey))}
                  disabled={busy}
                  className="rounded border px-1.5 py-0.5 disabled:opacity-50"
                  style={{ borderColor: "#fca5a5", color: "#b91c1c" }}
                >
                  Убрать
                </button>
              </div>
              {binding.latestSample && (
                <div className="mt-1 text-muted-foreground">
                  измерено на этом воркере: {new Date(binding.latestSample.observedAt).toLocaleString()} ({binding.latestSample.source})
                  {binding.latestSample.accountId ? ` · аккаунт: ${binding.latestSample.accountId}` : ""}
                </div>
              )}
              {metaOpen === binding.harnessKey && binding.latestSample?.meta != null && (
                <pre className="mt-1 overflow-auto rounded border p-2" style={{ maxHeight: 200 }}>
                  {JSON.stringify(binding.latestSample.meta, null, 2)}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          value={newKey}
          onChange={(event) => setNewKey(event.target.value)}
          placeholder="ключ harness'а, напр. claude"
          className="rounded border px-2 py-1 text-xs"
        />
        <button
          onClick={() => {
            const key = newKey.trim();
            if (!key) return;
            replaceBindings([...bindings, { harnessKey: key, enabled: true, subscriptionId: null }]);
            setNewKey("");
          }}
          disabled={busy || !newKey.trim()}
          className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
        >
          Добавить привязку
        </button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Лимит принадлежит подписке, не машине: два воркера под одним аккаунтом исчерпываются вместе. Закрытая подписка
        останавливает раздачу job'ов этого harness'а; отложенные задачи продолжатся сами — по времени сброса или когда лимит снимут.
      </p>
    </div>
  );
};

/** Editor for the worker-level scheduling limits: concurrency cap and the machine's own hours. */
const WorkerLimitsEditor: React.FC<{
  worker: AgentWorker;
  busy: boolean;
  onAction: (method: string, extra: Record<string, unknown>) => void;
}> = ({ worker, busy, onAction }) => {
  const [draft, setDraft] = useState(String(worker.maxConcurrentJobs ?? ""));
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <span className="font-medium">Одновременно job'ов:</span>
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="по умолчанию 1"
        className="w-24 rounded border px-2 py-1"
      />
      <button
        onClick={() => onAction("setWorkerLimits", {
          workerId: worker.id,
          maxConcurrentJobs: draft.trim() === "" ? null : Number(draft),
        })}
        disabled={busy}
        className="rounded border px-2 py-1 font-medium disabled:opacity-50"
      >
        Сохранить
      </button>
      <span className="text-muted-foreground">
        Пусто — сколько заявила сама машина (обычно 1). Git-job'ы тоже считаются: диск и CPU они занимают.
      </span>
    </div>
  );
};

/** Cross-worker subscriptions: one account can serve several machines, so this list is page-level. */
const SubscriptionsSection: React.FC<{
  subscriptions: HarnessSubscription[];
  busy: boolean;
  onAction: (method: string, extra: Record<string, unknown>) => void;
}> = ({ subscriptions, busy, onAction }) => {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("anthropic");
  return (
    <div className="rounded-lg border p-4">
      <h2 className="text-lg font-semibold">Подписки</h2>
      <p className="text-xs text-muted-foreground">
        Аккаунты провайдеров, которыми пользуются harness'ы воркеров. Исчерпание — свойство подписки: сигнал от любого
        воркера закрывает всех, кто на ней сидит. Секретов здесь нет — авторизация живёт на машинах воркеров.
      </p>
      <ul className="mt-2 space-y-2">
        {subscriptions.map((subscription) => (
          <li key={subscription.id} className="rounded border p-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{subscription.name}</span>
              <span className="text-muted-foreground">{subscription.provider}{subscription.authKind ? ` · ${subscription.authKind}` : ""}</span>
              {subscription.exhausted ? (
                <span style={{ color: "#b91c1c" }}>
                  🔴 исчерпана до {subscription.exhaustedUntil ? `${formatDateTime(subscription.exhaustedUntil)}${remainingSuffix(subscription.exhaustedUntil)}` : "?"}
                </span>
              ) : (
                <span style={{ color: "#047857" }}>🟢 открыта</span>
              )}
              {subscription.accountId && <span className="text-muted-foreground">аккаунт: {subscription.accountId}</span>}
            </div>
            <div className="mt-1 text-muted-foreground">{windowsSummary(subscription.windows ?? [])}</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {subscription.exhausted ? (
                <button
                  onClick={() => onAction("clearHarnessLimit", { subscriptionId: subscription.id })}
                  disabled={busy}
                  className="rounded border px-2 py-1 disabled:opacity-50"
                  style={{ borderColor: "#6ee7b7", color: "#047857" }}
                >
                  Снять лимит
                </button>
              ) : (
                <button
                  onClick={() => {
                    const until = window.prompt("Закрыть до (ISO или ГГГГ-ММ-ДД ЧЧ:ММ):", "");
                    if (!until) return;
                    onAction("markHarnessExhausted", { subscriptionId: subscription.id, until, reason: "закрыто вручную из панели" });
                  }}
                  disabled={busy}
                  className="rounded border px-2 py-1 disabled:opacity-50"
                >
                  Закрыть до…
                </button>
              )}
              <button
                onClick={() => {
                  const current = JSON.stringify({
                    resetSchedule: subscription.resetSchedule ?? null,
                    stopPolicy: subscription.stopPolicy ?? null,
                    authKind: subscription.authKind ?? null,
                  }, null, 2);
                  const edited = window.prompt("resetSchedule / stopPolicy / authKind (JSON):", current);
                  if (!edited) return;
                  try {
                    onAction("saveSubscription", { id: subscription.id, values: JSON.parse(edited) });
                  } catch {
                    window.alert("Невалидный JSON");
                  }
                }}
                disabled={busy}
                className="rounded border px-2 py-1 disabled:opacity-50"
              >
                Расписание и пороги…
              </button>
              <button
                onClick={() => {
                  if (window.confirm(`Удалить подписку «${subscription.name}»? Привязки воркеров останутся без подписки.`)) {
                    onAction("deleteSubscription", { subscriptionId: subscription.id });
                  }
                }}
                disabled={busy}
                className="rounded border px-1.5 py-0.5 disabled:opacity-50"
                style={{ borderColor: "#fca5a5", color: "#b91c1c" }}
              >
                Удалить
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Название, напр. Claude Max #1 (ivan)"
          className="w-64 rounded border px-2 py-1 text-xs"
        />
        <select value={provider} onChange={(event) => setProvider(event.target.value)} className="rounded border px-2 py-1 text-xs">
          <option value="anthropic">anthropic</option>
          <option value="openai">openai</option>
          <option value="other">other</option>
        </select>
        <button
          onClick={() => {
            if (!name.trim()) return;
            onAction("saveSubscription", { values: { name: name.trim(), provider, authKind: "subscription" } });
            setName("");
          }}
          disabled={busy || !name.trim()}
          className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
        >
          Новая подписка
        </button>
      </div>
    </div>
  );
};

const AgentizWorkers: React.FC = () => {
  useViewerTimezone();
  const [workers, setWorkers] = useState<AgentWorker[]>([]);
  const [workerApi, setWorkerApi] = useState<{ enabled: boolean; url: string }>({ enabled: false, url: "" });
  const [harnesses, setHarnesses] = useState<Record<string, WorkerHarnessBinding[]>>({});
  const [subscriptions, setSubscriptions] = useState<HarnessSubscription[]>([]);
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

  const fetchCapacity = useCallback(async () => {
    try {
      const res = await axios.get(API_URL, { params: { _method: "getCapacity" } });
      setHarnesses(res.data?.data?.harnesses ?? {});
      setSubscriptions(res.data?.data?.subscriptions ?? []);
    } catch {
      // Not fatal: the limits block simply stays empty.
      setHarnesses({});
      setSubscriptions([]);
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
    fetchCapacity();
    fetchProjects();
    fetchRepositoryOptions();
  }, [fetchWorkers, fetchCapacity, fetchProjects, fetchRepositoryOptions]);

  /** Harness/subscription mutations refresh both the worker list and the capacity block. */
  const capacityAction = useCallback(
    async (method: string, extra: Record<string, unknown> = {}) => {
      setBusy(true);
      setError(null);
      try {
        await axios.post(API_URL, { _method: method, ...extra });
        await Promise.all([fetchWorkers(), fetchCapacity()]);
      } catch (e: any) {
        setError(e?.response?.data?.message ?? "Действие с лимитами не удалось");
      } finally {
        setBusy(false);
      }
    },
    [fetchWorkers, fetchCapacity],
  );

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
                <>
                  <WorkerLimitsEditor worker={worker} busy={busy} onAction={capacityAction} />
                  <WorkerHarnessEditor
                    worker={worker}
                    bindings={harnesses[worker.id] ?? []}
                    subscriptions={subscriptions}
                    busy={busy}
                    onAction={capacityAction}
                  />
                  <WorkerGitPushRootsEditor
                    worker={worker}
                    busy={busy}
                    onSave={(gitPushRoots) => workerAction("setWorkerGitPushRoots", worker, { gitPushRoots })}
                  />
                  <WorkerWorkspacesEditor
                    worker={worker}
                    busy={busy}
                    onSave={(workspaces) => workerAction("setWorkerWorkspaces", worker, { workspaces })}
                  />
                  <WorkerExecutorsEditor
                    worker={worker}
                    busy={busy}
                    onSave={(manualExecutors) => workerAction("setWorkerManualExecutors", worker, { manualExecutors })}
                  />
                </>
              )}
            </li>
          ))}
        </ul>
      </div>

      <SubscriptionsSection subscriptions={subscriptions} busy={busy} onAction={capacityAction} />
    </div>
  );
};

export default AgentizWorkers;
