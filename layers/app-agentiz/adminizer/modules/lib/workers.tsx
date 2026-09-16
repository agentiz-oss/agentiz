import * as React from 'react';
import { AlertTriangle, KeyRound, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { href } from '../../../lib/panel/routeTree';
import { ago, plural, queryParam, setQueryParam } from './format';
import { EmptyState, Facts, PageHeader, Section as PageSection } from './page';
import { StatusBadge } from './status';
import { cn, toast } from './ui';
import { formatDateTime, formatRemaining, remainingSuffix, useViewerTimezone } from './viewerTime';

/**
 * The three fleet screens: «Воркеры», one machine, and «Обвязки и лимиты».
 *
 * One file because they are one subject seen from two ends. A binding (`worker × harness`) is
 * drawn on the machine's card and again under its subscription, and the two must not word the
 * same state differently — which is exactly what used to happen when the limits block lived
 * inside the workers screen and had no address of its own.
 *
 * Three states end in three different ways and are therefore never called the same thing here:
 *
 * * **лимит исчерпан** belongs to the *account* (`subscription.exhaustedUntil`) and has a moment
 *   it ends by itself, so it is the only one printed with a countdown;
 * * **нет входа** belongs to the *machine* (`AgentWorkerHarness.authState`), has no end moment at
 *   all and is fixed by a browser on that machine — no resume time is ever shown next to it;
 * * **вне рабочих часов** is a claim-side gate of the machine's own schedule and is shown as a
 *   schedule, never as a failure.
 *
 * `windows` is advisory telemetry: it is what a person reads, not what closes the queue. The only
 * thing that closes it is `exhaustedUntil`, so nothing here draws a percentage as a prohibition.
 */

const PREFIX: string = (window as any).routePrefix ?? '/dashboard';
const API = `${PREFIX}/agentiz-workers`;
const axios = (window as any).axios;

// ---------------------------------------------------------------------------------------------
// Wire shapes — what the server actually sends (`lib/workerBoard.ts`, `lib/capacityViews.ts`).
// ---------------------------------------------------------------------------------------------

export interface WorkerWorkspace {
  key: string;
  path: string;
  label?: string;
  description?: string;
  /** Set ⇒ only that project's specs may name this directory (`lib/workspaceOwnership.ts`). */
  projectId?: string | null;
  git?: { pushEnabled: boolean; remote?: string };
}

export interface WorkerExecutor {
  key: string;
  title?: string;
  acpCommand: string[];
}

export interface WorkerRow {
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
  revokedReason?: string | null;
  claimedJobsCount?: number;
  allowedProjectIds?: string[] | null;
  allowedRepositoryIds?: string[] | null;
  workspaces?: WorkerWorkspace[] | null;
  gitPushRoots?: string[] | null;
  manualExecutors?: WorkerExecutor[] | null;
  maxConcurrentJobs?: number | null;
  activeHours?: { timezone?: string; windows?: Array<{ days?: string[]; start?: string; end?: string }> } | null;
  timezone?: string | null;
  /** Derived on the server so the panel's dot and the claim gate cannot disagree. */
  contactState: 'online' | 'offline' | 'never_contacted';
  effectiveMaxConcurrentJobs: number;
  activeJobs: number;
}

export interface HarnessWindow {
  key: string;
  label?: string;
  /** Always the *spent* share, whatever `meter` says a person should read. */
  usedPercent?: number;
  resetsAt?: string | null;
  /** 'remaining' ⇒ print `100 − usedPercent`; absent = 'used', which every stored Claude window is. */
  meter?: 'used' | 'remaining';
  /** Length of this plan's session window (Claude: 300). Absent = the unit is unknown, not five hours. */
  sessionWindowMinutes?: number;
  observedAt?: string;
  source?: string;
}

export interface Subscription {
  id: string;
  name: string;
  provider: string;
  authKind?: string | null;
  accountId?: string | null;
  resetSchedule?: { kind?: string; day?: string; time?: string; timezone?: string; expr?: string } | null;
  stopPolicy?: Record<string, { pauseAtUsedPercent?: number } | undefined> | null;
  alignResetEnabled?: boolean;
  alignResetHour?: number | null;
  alignResetTimezone?: string | null;
  keepWindowsOpen?: boolean;
  windows: HarnessWindow[];
  exhausted: boolean;
  exhaustedUntil?: string | null;
  exhaustedReason?: string | null;
  /** «воркер ещё присылает» — moves with every report, even one that changed nothing. */
  lastSignalAt?: string | null;
  lastSignalSource?: string | null;
  /** «простой подписки» — moves only when a window's quota really moved. A different question. */
  lastLimitChangeAt?: string | null;
  lastPoke?: { at: string; ok: boolean; error?: string | null; failedSince?: string | null } | null;
}

export interface HarnessBinding {
  id: string;
  harnessKey: string;
  enabled: boolean;
  maxConcurrent?: number | null;
  subscription: Subscription | null;
  state: 'disabled' | 'unauthorized' | 'exhausted' | 'available';
  /** Whether this machine can log in at all; null = nobody ever said, and that is not a problem. */
  authState?: 'ok' | 'expired' | null;
  authDetail?: string | null;
  authFailedSince?: string | null;
  latestSample: { observedAt: string; source: string; windows: HarnessWindow[]; meta?: unknown; accountId?: string | null } | null;
  accountMismatch: boolean;
  runningJobs: number;
  queuedJobs: number;
}

export interface WorkerFleet {
  workers: WorkerRow[];
  harnesses: Record<string, HarnessBinding[]>;
  subscriptions: Subscription[];
  projects: Array<{ id: string; name: string; slug: string }>;
  repositories: Array<{ id: string; provider: string; pathWithNamespace: string }>;
  workerApi: { enabled: boolean; url: string };
  /** Whether this person holds `agentiz-workers-manage`. Every write is checked again server-side. */
  canManage: boolean;
}

interface IssuedToken {
  workerName: string;
  token: string;
  workerApiUrl: string;
}

// ---------------------------------------------------------------------------------------------
// Reading the fleet
// ---------------------------------------------------------------------------------------------

const DAY_LABELS: Record<string, string> = {
  mon: 'пн', tue: 'вт', wed: 'ср', thu: 'чт', fri: 'пт', sat: 'сб', sun: 'вс',
};

const KIND_LABELS: Record<string, string> = { local: 'встроенный', external: 'внешний' };

/** What the badge of a machine says: its own status first, the contact dot only for a live one. */
function fleetStatus(worker: WorkerRow): string {
  return worker.status === 'active' ? worker.contactState : worker.status;
}

/** A paused, revoked, never-connected or silent worker should not crowd the live fleet. */
function isInactive(worker: WorkerRow): boolean {
  return worker.status !== 'active' || worker.contactState !== 'online';
}

/** `agentiz-worker/0.0.1+df88b53` → `0.0.1+df88b53`; anything else is printed as it came. */
function versionLabel(version?: string | null): string {
  if (!version) return '—';
  const match = version.match(/^agentiz-worker\/(.+)\+([0-9a-f]{7,}|unknown)$/i);
  return match ? `${match[1]}+${match[2]}` : version;
}

function contactLabel(worker: WorkerRow): string {
  if (worker.contactState === 'never_contacted') return 'ещё не подключался';
  if (worker.contactState === 'online') return 'на связи';
  return `нет связи ${ago(worker.lastSeenAt)}`;
}

function activeHoursLabel(schedule: WorkerRow['activeHours']): string {
  const windows = schedule?.windows ?? [];
  if (windows.length === 0) return 'круглосуточно';
  const text = windows
    .map((window) => `${(window.days ?? []).map((day) => DAY_LABELS[day] ?? day).join(', ')} ${window.start}–${window.end}`)
    .join('; ');
  return schedule?.timezone ? `${text} (${schedule.timezone})` : text;
}

/**
 * The one-line answer to «возьмёт ли эта машина работу прямо сейчас», in the column the fleet list
 * is scanned by. Each of the four reasons is named as itself — a harness the operator switched
 * off, a machine nobody is logged in on and a spent account are three different repairs.
 */
function availabilityLabel(worker: WorkerRow, bindings: HarnessBinding[]): string {
  if (worker.status === 'revoked') return 'Отозван';
  if (worker.status === 'paused') return 'На паузе';
  if (worker.contactState === 'never_contacted') return 'Не подключался';
  if (worker.contactState === 'offline') return `Нет связи ${ago(worker.lastSeenAt)}`;
  const blocked = bindings.filter((binding) => binding.state !== 'available');
  if (bindings.length > 0 && blocked.length === bindings.length) {
    return blocked.map((binding) => `${binding.harnessKey}: ${BLOCK_WORDS[binding.state]}`).join(' · ');
  }
  if (blocked.length > 0) return `частично: ${blocked.map((binding) => binding.harnessKey).join(', ')}`;
  return 'Доступен';
}

const BLOCK_WORDS: Record<HarnessBinding['state'], string> = {
  disabled: 'выключена',
  unauthorized: 'нет входа',
  exhausted: 'лимит',
  available: 'доступна',
};

/**
 * Reads one telemetry window the way its provider meant it to be read.
 *
 * `usedPercent` is always the spent share — that is what `stopPolicy` compares and what every
 * sample stores. `meter: 'remaining'` (Codex, whose own console counts down) only changes the
 * sentence a person sees. The bar fills with the number printed beside it while the colour follows
 * the *spent* share either way, so a nearly empty «осталось» bar is the alarming one.
 */
function windowReading(window: HarnessWindow): { text: string; fill: number | null; spent: number | null } {
  const spent = typeof window.usedPercent === 'number'
    ? Math.min(Math.max(Math.round(window.usedPercent), 0), 100)
    : null;
  if (spent === null) return { text: 'нет данных', fill: null, spent: null };
  const remaining = window.meter === 'remaining';
  const shown = remaining ? 100 - spent : spent;
  return { text: remaining ? `осталось ${shown} %` : `потрачено ${shown} %`, fill: shown, spent };
}

/**
 * «ещё 9 полных 5-часовых окон» — the only thing a weekly figure is read for, because «осталось
 * 154 ч 12 мин» is not a number anybody plans against.
 *
 * Licensed solely by `sessionWindowMinutes`: without it the plan's unit is unknown, and saying
 * "five hours" would be inventing one. Nothing is said either when the reset is no further out
 * than a single window — the plain time left reads fine at that scale, and the session window
 * would otherwise report a count of itself.
 */
function fullSessionWindows(window: HarnessWindow): string | null {
  const length = window.sessionWindowMinutes;
  if (!window.resetsAt || !length || length <= 0) return null;
  const left = Math.floor((new Date(window.resetsAt).getTime() - Date.now()) / 60_000);
  if (!Number.isFinite(left) || left <= length) return null;
  const count = Math.floor(left / length);
  const unit = length % 60 === 0 ? `${length / 60}-часов` : `${length}-минутн`;
  const noun = plural(count, `полное ${unit}ое окно`, `полных ${unit}ых окна`, `полных ${unit}ых окон`);
  return `ещё ${count} ${noun}`;
}

/** «лимиты без изменений 4 мин» — the account's idle clock, never the heartbeat's freshness. */
function idleLimitsLabel(lastLimitChangeAt?: string | null): string | null {
  if (!lastLimitChangeAt) return null;
  const minutes = Math.floor((Date.now() - new Date(lastLimitChangeAt).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  if (minutes < 1) return 'только что';
  return ago(lastLimitChangeAt);
}

function alignmentLabel(subscription: Subscription): string {
  const parts: string[] = [];
  if (subscription.alignResetEnabled && subscription.alignResetHour != null) {
    parts.push(`на ${String(subscription.alignResetHour).padStart(2, '0')}:00`
      + (subscription.alignResetTimezone ? ` (${subscription.alignResetTimezone})` : ''));
  } else {
    parts.push('выключено');
  }
  if (subscription.keepWindowsOpen) parts.push('окна подряд');
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------------------------
// Small shared pieces of this subject
// ---------------------------------------------------------------------------------------------

const METER_TONES = { default: 'bg-chart-1', warn: 'bg-warning', danger: 'bg-destructive' } as const;

function Meter({ percent, tone = 'default' }: { percent: number; tone?: keyof typeof METER_TONES }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className={cn('h-full rounded-full', METER_TONES[tone])} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
  );
}

function KeyValue({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
  );
}

/** The fleet screens separate their sections with a rule — see `Section` in `lib/page.tsx`. */
function Section(props: Omit<React.ComponentProps<typeof PageSection>, 'variant'>) {
  return <PageSection {...props} variant="divided" />;
}

/**
 * In-place replacement for `window.confirm`: the first click swaps the button for the question
 * with an explicit destructive button beside a cancel, in the same row.
 */
function ConfirmButton({ label, question, busy, onConfirm, size = 'sm' }: {
  label: string;
  question: string;
  busy: boolean;
  onConfirm: () => void;
  size?: 'sm' | 'default';
}) {
  const [open, setOpen] = React.useState(false);
  if (!open) {
    return (
      <Button variant="outline" size={size} disabled={busy} className="text-destructive" onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 px-2 py-1 text-xs">
      <span>{question}</span>
      <Button variant="destructive" size="sm" disabled={busy} onClick={() => { setOpen(false); onConfirm(); }}>{label}</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setOpen(false)}>Отмена</Button>
    </span>
  );
}

/**
 * «Закрыть до…» — a moment and a reason, because the gate this closes is the one field that
 * actually stops the queue. The moment is read in the viewer's zone and sent as ISO; the server
 * refuses anything in the past, so the button stays disabled until it is not.
 */
function MarkExhaustedForm({ label, busy, onSubmit }: {
  label: string;
  busy: boolean;
  onSubmit: (untilIso: string, reason: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [until, setUntil] = React.useState('');
  const [reason, setReason] = React.useState('закрыто вручную из панели');
  if (!open) {
    return <Button variant="outline" size="sm" disabled={busy} onClick={() => setOpen(true)}>{label}</Button>;
  }
  const parsed = until ? new Date(until) : null;
  const valid = parsed !== null && !Number.isNaN(parsed.getTime()) && parsed.getTime() > Date.now();
  return (
    <span className="inline-flex flex-wrap items-center gap-2 rounded-lg border px-2 py-1 text-xs">
      <span>до</span>
      <Input type="datetime-local" value={until} onChange={(event: any) => setUntil(event.target.value)} className="h-8 w-52" />
      <Input value={reason} onChange={(event: any) => setReason(event.target.value)} placeholder="причина" className="h-8 w-48" />
      <Button
        size="sm"
        disabled={busy || !valid}
        onClick={() => {
          if (!parsed) return;
          onSubmit(parsed.toISOString(), reason.trim());
          setOpen(false);
          setUntil('');
        }}
      >
        Закрыть
      </Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setOpen(false)}>Отмена</Button>
    </span>
  );
}

/** The windows of one subscription. Advisory telemetry — it explains the gate, it is not the gate. */
function WindowList({ windows, observedAt }: { windows: HarnessWindow[]; observedAt?: string | null }) {
  if (windows.length === 0) {
    return <p className="text-sm text-muted-foreground">Телеметрии пока нет — воркер ещё не присылал цифры по этой обвязке.</p>;
  }
  return (
    <div className="space-y-3">
      {windows.map((window) => {
        const reading = windowReading(window);
        const sessions = fullSessionWindows(window);
        const tone = reading.spent === null ? 'default' : reading.spent >= 90 ? 'danger' : reading.spent >= 70 ? 'warn' : 'default';
        return (
          <div key={window.key}>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate">{window.label ?? window.key}</span>
              <span className="shrink-0 text-muted-foreground">{reading.text}</span>
            </div>
            <Meter percent={reading.fill ?? 0} tone={tone} />
            <div className="mt-1 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span>{window.resetsAt ? `сброс ${formatDateTime(window.resetsAt)}` : 'момент сброса неизвестен'}</span>
              <span>
                {formatRemaining(window.resetsAt) ? `осталось ${formatRemaining(window.resetsAt)}` : ''}
                {sessions ? `, ${sessions}` : ''}
              </span>
            </div>
          </div>
        );
      })}
      {observedAt && <p className="text-xs text-muted-foreground">Данные на {formatDateTime(observedAt)}</p>}
    </div>
  );
}

/**
 * The one state on these screens nobody can clear from here: the credential lives on the worker
 * machine and only a browser there renews it. It deliberately carries no moment of return —
 * `run.waitingUntil` stays null for exactly this reason, and a number here would be a promise
 * nobody keeps.
 */
function AuthNote({ binding }: { binding: HarnessBinding }) {
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
      <div className="flex items-center gap-2 font-medium text-destructive">
        <KeyRound className="size-4" /> Нет входа в обвязку на этой машине
      </div>
      <p className="mt-1 text-muted-foreground">
        {binding.authFailedSince ? `Авторизация закончилась ${formatDateTime(binding.authFailedSince)}. ` : ''}
        Работы этой обвязки на этой машине стоят в очереди, и сами они не поедут: срока у этого состояния нет.
        Войдите в аккаунт на самой машине воркера
        {binding.harnessKey === 'claude' ? ' (claude auth login под пользователем воркера, подтверждение в браузере)' : ''}
        {' '}— очередь продолжится сама через пару минут после входа.
      </p>
      {binding.authDetail && <p className="mt-1 font-mono text-xs text-muted-foreground">{binding.authDetail.slice(0, 200)}</p>}
    </div>
  );
}

/** What became of the one thing the server ever asks a worker to *do* about limits. */
function PokeNote({ subscription }: { subscription: Subscription }) {
  const poke = subscription.lastPoke;
  // Null means either "никогда не просили" or "воркер старше поля" — never "не работает".
  if (!poke) return <>не спрашивали</>;
  if (poke.ok) return <>успешно {formatDateTime(poke.at)}</>;
  return (
    <span className="text-destructive">
      не удаётся{poke.failedSince ? ` с ${formatDateTime(poke.failedSince)}` : ''}: {poke.error || 'воркер не назвал причину'}
    </span>
  );
}

/** A list of строк-chips with a remove button — allowlists, push roots, executors. */
function Chips({ items, busy, onRemove }: {
  items: Array<{ id: string; label: string; hint?: string }>;
  busy: boolean;
  onRemove?: (id: string) => void;
}) {
  return (
    <ul className="flex flex-wrap gap-2">
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-2 rounded-lg border px-2 py-1 text-xs">
          <span className="font-mono">{item.label}</span>
          {item.hint && <span className="text-muted-foreground">{item.hint}</span>}
          {onRemove && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onRemove(item.id)}
              className="text-muted-foreground hover:text-destructive disabled:opacity-50"
            >
              ×
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// The one conversation with the server these screens have
// ---------------------------------------------------------------------------------------------

interface FleetPolling {
  /** How often to re-read the machines, in ms. Absent = never. */
  workersEvery?: number;
  /** How often to re-read bindings and subscriptions, in ms. Absent = never. */
  capacityEvery?: number;
}

/**
 * The fleet as state: the server-rendered first frame, the polls that keep it true, and the one
 * `post` every button goes through.
 *
 * Polling is quiet on purpose — a server restarting mid-deploy would otherwise stack a toast on
 * every tick — and the screen says «не обновляется» once instead. It also stands aside while a
 * write is in flight, so a reply is never overwritten by an answer that predates it.
 */
function useFleet(initial: WorkerFleet, polling: FleetPolling) {
  const [fleet, setFleet] = React.useState<WorkerFleet>(initial);
  const [busy, setBusy] = React.useState(false);
  const [stale, setStale] = React.useState(false);
  const writing = React.useRef(false);

  const loadWorkers = React.useCallback(async (quiet: boolean) => {
    try {
      const response = await axios.get(API, { params: { _method: 'getWorkers' } });
      setFleet((current) => ({
        ...current,
        workers: response.data?.data ?? [],
        workerApi: {
          enabled: Boolean(response.data?.meta?.workerApiEnabled),
          url: response.data?.meta?.workerApiUrl ?? current.workerApi.url,
        },
      }));
      setStale(false);
    } catch (error: any) {
      setStale(true);
      if (!quiet) toast.error(error?.response?.data?.message ?? 'Не удалось загрузить воркеров');
    }
  }, []);

  const loadCapacity = React.useCallback(async (quiet: boolean) => {
    try {
      const response = await axios.get(API, { params: { _method: 'getCapacity' } });
      setFleet((current) => ({
        ...current,
        harnesses: response.data?.data?.harnesses ?? {},
        subscriptions: response.data?.data?.subscriptions ?? [],
      }));
      setStale(false);
    } catch (error: any) {
      setStale(true);
      if (!quiet) toast.error(error?.response?.data?.message ?? 'Не удалось загрузить лимиты');
    }
  }, []);

  React.useEffect(() => {
    if (!polling.workersEvery) return undefined;
    const timer = window.setInterval((): void => { if (!writing.current) void loadWorkers(true); }, polling.workersEvery);
    return (): void => { window.clearInterval(timer); };
  }, [loadWorkers, polling.workersEvery]);

  React.useEffect(() => {
    if (!polling.capacityEvery) return undefined;
    const timer = window.setInterval((): void => { if (!writing.current) void loadCapacity(true); }, polling.capacityEvery);
    return (): void => { window.clearInterval(timer); };
  }, [loadCapacity, polling.capacityEvery]);

  /** Every write on these screens. Both halves are re-read after it: a binding changes both. */
  const post = React.useCallback(async (body: Record<string, unknown>, success?: string) => {
    writing.current = true;
    setBusy(true);
    try {
      const response = await axios.post(API, body);
      if (success) toast.success(success);
      await Promise.all([loadWorkers(false), loadCapacity(false)]);
      return response.data?.data ?? null;
    } catch (error: any) {
      toast.error(error?.response?.data?.message ?? 'Действие не удалось');
      return null;
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }, [loadCapacity, loadWorkers]);

  return { fleet, busy, stale, post };
}

/** The token the server hands out exactly once — kept on screen until it is dismissed. */
function IssuedTokenCard({ issued, onClose }: { issued: IssuedToken; onClose: () => void }) {
  return (
    <div className="mb-5 rounded-lg border border-warning/50 bg-warning/10 p-4 text-sm">
      <div className="font-medium">Токен воркера «{issued.workerName}» — показывается один раз</div>
      <code className="mt-2 block break-all rounded border bg-background px-2 py-1 font-mono text-xs">{issued.token}</code>
      <p className="mt-2 text-muted-foreground">
        На машине воркера запустите настройку, выберите сервер и вставьте токен. Как установить воркер —{' '}
        <a href="https://docs.agentiz.m42.cx/worker-install" target="_blank" rel="noreferrer" className="underline">
          docs.agentiz.m42.cx/worker-install
        </a>
      </p>
      <code className="mt-2 block break-all rounded border bg-background px-2 py-1 font-mono text-xs">
        {`agentiz-worker configure  # сервер: ${issued.workerApiUrl}`}
      </code>
      <Button variant="outline" size="sm" className="mt-3" onClick={onClose}>Я скопировал</Button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// «Воркеры» — the fleet
// ---------------------------------------------------------------------------------------------

export function WorkersScreen({ initial }: { initial: WorkerFleet }) {
  useViewerTimezone();
  const { fleet, busy, stale, post } = useFleet(initial, { workersEvery: 10_000, capacityEvery: 30_000 });
  const [name, setName] = React.useState('');
  const [issued, setIssued] = React.useState<IssuedToken | null>(null);
  const [showInactive, setShowInactive] = React.useState(queryParam('inactive') === '1');

  const inactive = fleet.workers.filter(isInactive);
  const shown = showInactive ? fleet.workers : fleet.workers.filter((worker) => !isInactive(worker));
  const online = fleet.workers.filter((worker) => worker.status === 'active' && worker.contactState === 'online').length;

  const create = async () => {
    // The name is a label, not an identifier: an empty field gets a default instead of blocking
    // the one button that is the whole onboarding.
    const workerName = name.trim() || `worker-${fleet.workers.length + 1}`;
    const created = await post({ _method: 'createWorker', name: workerName }, 'Воркер создан');
    if (created?.token) {
      setIssued({ workerName, token: created.token, workerApiUrl: created.workerApiUrl ?? fleet.workerApi.url });
      setName('');
    }
  };

  const toggleInactive = () => {
    const next = !showInactive;
    setShowInactive(next);
    setQueryParam('inactive', next ? '1' : null);
  };

  return (
    <>
      <PageHeader
        title="Воркеры"
        description="Машины, которые забирают работы из очереди и выполняют этапы пайплайнов. Подписки на обвязки живут отдельно: лимит принадлежит аккаунту, а не машине."
        meta={[
          <span key="count">{fleet.workers.length} {plural(fleet.workers.length, 'машина', 'машины', 'машин')}</span>,
          <span key="online">{online} на связи</span>,
          stale ? <span key="stale" className="agentiz-attention">не обновляется — сервер не отвечает</span> : null,
        ]}
        actions={fleet.canManage ? (
          <>
            <Input
              value={name}
              onChange={(event: any) => setName(event.target.value)}
              onKeyDown={(event: any) => { if (event.key === 'Enter') void create(); }}
              placeholder="Название (необязательно)"
              className="h-9 w-52"
            />
            <Button disabled={busy} onClick={() => create()}><Plus /> Новый воркер</Button>
          </>
        ) : undefined}
      />

      {issued && <IssuedTokenCard issued={issued} onClose={() => setIssued(null)} />}

      {!fleet.workerApi.enabled && (
        <p className="mb-4 rounded-lg border p-3 text-sm text-muted-foreground">
          Worker API выключен (<code className="font-mono">AGENTIZ_WORKER_API_ENABLED=false</code>) — внешние воркеры
          подключиться не смогут, очередь разбирает встроенный воркер.
        </p>
      )}

      {fleet.workers.length === 0 ? (
        <EmptyState
          title="Воркеров нет"
          description="Нажмите «Новый воркер» — панель выдаст токен, с которым машина сразу подключится."
        />
      ) : (
        <>
          {inactive.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                {showInactive ? 'Показаны все машины' : `Скрыто неактивных: ${inactive.length}`} — не в сети,
                не подключались, на паузе или отозваны.
              </span>
              <Button variant="outline" size="sm" onClick={toggleInactive}>
                {showInactive ? 'Скрыть неактивные' : 'Показать неактивные'}
              </Button>
            </div>
          )}
          {shown.length === 0 ? (
            <EmptyState title="Активных воркеров нет" description="Раскройте неактивные, чтобы ими управлять." />
          ) : (
            <ul className="divide-y rounded-lg border">
              {shown.map((worker) => (
                <li key={worker.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <a href={href('worker', { workerId: worker.id })} className="text-sm font-medium hover:underline">
                      {worker.name}
                    </a>
                    <p className="truncate text-xs text-muted-foreground">
                      {[KIND_LABELS[worker.kind] ?? worker.kind, versionLabel(worker.version), worker.hostname]
                        .filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <StatusBadge status={fleetStatus(worker)} className="w-32 shrink-0 justify-center" />
                  <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                    {worker.activeJobs} / {worker.effectiveMaxConcurrentJobs}
                  </span>
                  <span className="w-56 shrink-0 truncate text-right text-xs text-muted-foreground max-lg:hidden">
                    {availabilityLabel(worker, fleet.harnesses[worker.id] ?? [])}
                  </span>
                  <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">
                    {worker.lastSeenAt ? ago(worker.lastSeenAt) : '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// One machine
// ---------------------------------------------------------------------------------------------

const EXECUTOR_PRESETS: Record<string, WorkerExecutor> = {
  claude: { key: 'claude', title: 'Claude', acpCommand: ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.66.0'] },
  codex: { key: 'codex', title: 'Codex', acpCommand: ['npx', '-y', '@agentclientprotocol/codex-acp@1.1.14'] },
};

const WORKER_TABS = [
  { value: 'overview', label: 'Обзор' },
  { value: 'access', label: 'Доступ' },
  { value: 'executors', label: 'Исполнители' },
  { value: 'workspaces', label: 'Папки' },
  { value: 'git', label: 'Git' },
  { value: 'harnesses', label: 'Обвязки' },
];

const NO_PROJECT = '__shared__';
/** Radix refuses an empty item value, so «нет подписки» needs a sentinel of its own. */
const NO_SUBSCRIPTION = '__none__';

export function WorkerScreen({ initial, workerId }: { initial: WorkerFleet; workerId: string }) {
  useViewerTimezone();
  const worker = initial.workers.find((item) => item.id === workerId) ?? null;
  const { fleet, busy, stale, post } = useFleet(initial, {
    workersEvery: worker && worker.status !== 'revoked' ? 10_000 : undefined,
    capacityEvery: worker && worker.status !== 'revoked' ? 30_000 : undefined,
  });
  const [tab, setTab] = React.useState(queryParam('tab') ?? 'overview');
  const [issued, setIssued] = React.useState<IssuedToken | null>(null);

  const current = fleet.workers.find((item) => item.id === workerId) ?? null;
  const bindings = fleet.harnesses[workerId] ?? [];

  const selectTab = (value: string) => {
    setTab(value);
    setQueryParam('tab', value === 'overview' ? null : value);
  };

  const act = (method: string, extra: Record<string, unknown>, success: string) =>
    post({ _method: method, workerId, ...extra }, success);

  if (!current) {
    return (
      <>
        <PageHeader title="Воркер" />
        <EmptyState
          title="Воркер не найден"
          description="Машина удалена или адрес устарел."
          action={<Button asChild variant="outline"><a href={href('workers')}>Все воркеры</a></Button>}
        />
      </>
    );
  }

  const readOnly = !fleet.canManage;
  const revoked = current.status === 'revoked';
  const projectName = (id: string) => fleet.projects.find((project) => project.id === id)?.name ?? id;
  const repositoryName = (id: string) => fleet.repositories.find((repository) => repository.id === id)?.pathWithNamespace ?? id;

  return (
    <>
      <PageHeader
        title={current.name}
        meta={[
          <StatusBadge key="status" status={fleetStatus(current)} />,
          <span key="kind">{KIND_LABELS[current.kind] ?? current.kind}</span>,
          <span key="version" className="font-mono text-xs">{versionLabel(current.version)}</span>,
          stale ? <span key="stale" className="agentiz-attention">не обновляется — сервер не отвечает</span> : null,
        ]}
        actions={readOnly || revoked ? undefined : (
          <>
            {current.status === 'paused' ? (
              <Button variant="outline" disabled={busy} onClick={() => act('resumeWorker', {}, 'Воркер снят с паузы')}>
                Включить
              </Button>
            ) : (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => act('pauseWorker', { reason: 'paused from admin panel' }, 'Воркер поставлен на паузу')}
              >
                На паузу
              </Button>
            )}
            {current.kind !== 'local' && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  void act('rotateWorkerToken', {}, 'Токен перевыпущен').then((result) => {
                    if (result?.token) {
                      setIssued({ workerName: current.name, token: result.token, workerApiUrl: result.workerApiUrl ?? fleet.workerApi.url });
                    }
                  });
                }}
              >
                Перевыпустить токен
              </Button>
            )}
          </>
        )}
        tabs={
          <Tabs value={tab} onValueChange={selectTab}>
            <TabsList>
              {WORKER_TABS.map((entry) => (
                <TabsTrigger key={entry.value} value={entry.value}>
                  {entry.label}
                  {entry.value === 'harnesses' && bindings.length > 0 && (
                    <span className="ml-1.5 text-xs text-muted-foreground">{bindings.length}</span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        }
      />

      {issued && <IssuedTokenCard issued={issued} onClose={() => setIssued(null)} />}

      {revoked && (
        <p className="mb-5 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          Доступ отозван{current.revokedReason ? `: ${current.revokedReason}` : ''}. Токен больше не работает, и настройки
          машины не редактируются — её можно только удалить.
        </p>
      )}

      {tab === 'overview' && (
        <div className="space-y-6">
          <Facts
            items={[
              ['Экземпляр', current.instanceId ?? 'ещё не подключался'],
              ['Хост', current.hostname ?? '—'],
              ['Связь', contactLabel(current)],
              ['Последний раз', current.lastSeenAt ? formatDateTime(current.lastSeenAt) : '—'],
              ['Работ сейчас', `${current.activeJobs} из ${current.effectiveMaxConcurrentJobs}`],
              ['Взято работ всего', String(current.claimedJobsCount ?? 0)],
              ['Версия', <span key="v" className="font-mono text-xs">{versionLabel(current.version)}</span>],
              ['Токен', current.tokenPrefix ? `${current.tokenPrefix}…` : 'без токена'],
              ['Зарегистрирован', current.registeredAt ? formatDateTime(current.registeredAt) : '—'],
              ['Рабочие часы', activeHoursLabel(current.activeHours)],
              ['Зона машины', current.timezone ?? 'не сообщена'],
              ['Обвязки', bindings.length ? bindings.map((binding) => binding.harnessKey).join(', ') : '—'],
            ]}
          />

          <p className="text-sm text-muted-foreground">
            Рабочие часы — это гейт момента взятия работы, а не пауза: вне окна машина просто не берёт новых работ,
            а работа без привязки к ней немедленно уезжает на другую. Расписание и зона правятся через MCP
            (<code className="font-mono">agentiz.manageWorker</code>).
          </p>

          {!readOnly && current.kind !== 'local' && (
            <>
              <Separator />
              <div>
                <h2 className="text-sm font-semibold">Опасная зона</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Отзыв гасит токен и оставляет запись; удаление возвращает работы этой машины в очередь.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {!revoked && (
                    <ConfirmButton
                      label="Отозвать"
                      question={`Отозвать доступ воркера «${current.name}»? Токен перестанет работать.`}
                      busy={busy}
                      onConfirm={() => act('revokeWorker', { reason: 'revoked from admin panel' }, 'Доступ отозван')}
                    />
                  )}
                  <ConfirmButton
                    label="Удалить"
                    question={`Удалить воркера «${current.name}»? Его работы вернутся в очередь.`}
                    busy={busy}
                    onConfirm={() => {
                      void post({ _method: 'deleteWorker', workerId }, 'Воркер удалён').then(() => {
                        window.location.href = href('workers');
                      });
                    }}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'access' && (
        <div>
          <Section
            title="Проекты"
            description="Пустой список — любые проекты. Иначе машина берёт работы только перечисленных."
          >
            {(current.allowedProjectIds ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">Все проекты.</p>
            ) : (
              <Chips
                busy={busy}
                items={(current.allowedProjectIds ?? []).map((id) => ({ id, label: projectName(id) }))}
                onRemove={readOnly || revoked ? undefined : (id) => act(
                  'setWorkerProjects',
                  { allowedProjectIds: (current.allowedProjectIds ?? []).filter((item) => item !== id) },
                  'Список проектов сохранён',
                )}
              />
            )}
            {!readOnly && !revoked && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Select
                  value=""
                  onValueChange={(value: string) => act(
                    'setWorkerProjects',
                    { allowedProjectIds: Array.from(new Set([...(current.allowedProjectIds ?? []), value])) },
                    'Список проектов сохранён',
                  )}
                >
                  <SelectTrigger size="sm" className="h-8 w-72"><SelectValue placeholder="Добавить проект…" /></SelectTrigger>
                  <SelectContent>
                    {fleet.projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {(current.allowedProjectIds ?? []).length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => act('setWorkerProjects', { allowedProjectIds: [] }, 'Доступ открыт на все проекты')}
                  >
                    Разрешить все
                  </Button>
                )}
              </div>
            )}
          </Section>

          <Section
            title="Репозитории"
            description="Пустой список — все репозитории разрешённых проектов. Работа без репозитория не ограничивается никогда."
          >
            {(current.allowedRepositoryIds ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">Все репозитории разрешённых проектов.</p>
            ) : (
              <Chips
                busy={busy}
                items={(current.allowedRepositoryIds ?? []).map((id) => ({ id, label: repositoryName(id) }))}
                onRemove={readOnly || revoked ? undefined : (id) => act(
                  'setWorkerRepositories',
                  { allowedRepositoryIds: (current.allowedRepositoryIds ?? []).filter((item) => item !== id) },
                  'Список репозиториев сохранён',
                )}
              />
            )}
            {!readOnly && !revoked && fleet.repositories.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Select
                  value=""
                  onValueChange={(value: string) => act(
                    'setWorkerRepositories',
                    { allowedRepositoryIds: Array.from(new Set([...(current.allowedRepositoryIds ?? []), value])) },
                    'Список репозиториев сохранён',
                  )}
                >
                  <SelectTrigger size="sm" className="h-8 w-96"><SelectValue placeholder="Добавить репозиторий…" /></SelectTrigger>
                  <SelectContent>
                    {fleet.repositories.map((repository) => (
                      <SelectItem key={repository.id} value={repository.id}>{repository.pathWithNamespace}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {(current.allowedRepositoryIds ?? []).length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => act('setWorkerRepositories', { allowedRepositoryIds: [] }, 'Доступ открыт на все репозитории')}
                  >
                    Разрешить все
                  </Button>
                )}
              </div>
            )}
            {fleet.repositories.length === 0 && !readOnly && (
              <p className="mt-3 text-xs text-muted-foreground">
                Список репозиториев виден только с правом на git-подключения — без него ограничение правится через MCP.
              </p>
            )}
          </Section>

          <Section
            title="Одновременных работ"
            description="Проверяется в момент взятия работы, под блокировкой строки воркера. Git-работы считаются тоже: диск и CPU они занимают."
          >
            <ConcurrencyEditor worker={current} busy={busy} readOnly={readOnly || revoked} onSave={(value) => post(
              { _method: 'setWorkerLimits', workerId, maxConcurrentJobs: value },
              'Ограничение сохранено',
            )} />
          </Section>
        </div>
      )}

      {tab === 'executors' && (
        <ExecutorsTab
          worker={current}
          busy={busy}
          readOnly={readOnly || revoked}
          onSave={(manualExecutors) => act('setWorkerManualExecutors', { manualExecutors }, 'Исполнители сохранены')}
        />
      )}

      {tab === 'workspaces' && (
        <WorkspacesTab
          worker={current}
          projects={fleet.projects}
          busy={busy}
          readOnly={readOnly || revoked}
          onSave={(workspaces) => act('setWorkerWorkspaces', { workspaces }, 'Папки сохранены')}
        />
      )}

      {tab === 'git' && (
        <GitTab
          worker={current}
          busy={busy}
          readOnly={readOnly || revoked}
          onSave={(gitPushRoots) => act('setWorkerGitPushRoots', { gitPushRoots }, 'Права на push сохранены')}
        />
      )}

      {tab === 'harnesses' && (
        <HarnessesTab
          workerId={workerId}
          bindings={bindings}
          subscriptions={fleet.subscriptions}
          busy={busy}
          readOnly={readOnly || revoked}
          post={post}
        />
      )}
    </>
  );
}

/** The machine's concurrency cap. Empty means "сколько заявила сама машина", not zero. */
function ConcurrencyEditor({ worker, busy, readOnly, onSave }: {
  worker: WorkerRow;
  busy: boolean;
  readOnly: boolean;
  onSave: (value: number | null) => void;
}) {
  const [draft, setDraft] = React.useState(String(worker.maxConcurrentJobs ?? ''));
  if (readOnly) {
    return (
      <p className="text-sm">
        {worker.effectiveMaxConcurrentJobs}
        {worker.maxConcurrentJobs == null ? ' (как заявила машина)' : ''}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={draft}
        onChange={(event: any) => setDraft(event.target.value)}
        placeholder={String(worker.effectiveMaxConcurrentJobs)}
        className="h-8 w-24"
      />
      <Button size="sm" disabled={busy} onClick={() => onSave(draft.trim() === '' ? null : Number(draft))}>
        Сохранить
      </Button>
      <span className="text-xs text-muted-foreground">
        Сейчас в силе: {worker.effectiveMaxConcurrentJobs}. Пусто — сколько заявила сама машина (обычно 1).
      </span>
    </div>
  );
}

/** The manual-launch picker deliberately offers named profiles, never a command input. */
function ExecutorsTab({ worker, busy, readOnly, onSave }: {
  worker: WorkerRow;
  busy: boolean;
  readOnly: boolean;
  onSave: (executors: WorkerExecutor[]) => void;
}) {
  const executors = worker.manualExecutors ?? [];
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Профили, которые можно выбрать при ручном запуске. Выбранный профиль закрепляет работу за этой машиной —
        только на ней этот исполнитель и установлен. Команда ACP хранится в профиле воркера и никогда не приезжает
        из формы запуска.
      </p>
      {executors.length === 0 ? (
        <EmptyState
          title="Исполнителей нет"
          description="Ручной запуск воспользуется исполнителем, заданным в пайплайне."
        />
      ) : (
        <ul className="divide-y rounded-lg border">
          {executors.map((executor) => (
            <li key={executor.key} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <span className="w-32 shrink-0 text-sm font-medium">{executor.title || executor.key}</span>
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                {(executor.acpCommand ?? []).join(' ')}
              </code>
              {!readOnly && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  className="text-destructive"
                  onClick={() => onSave(executors.filter((item) => item.key !== executor.key))}
                >
                  Убрать
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          {Object.values(EXECUTOR_PRESETS).map((preset) => (
            <Button
              key={preset.key}
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onSave([...executors.filter((item) => item.key !== preset.key), preset])}
            >
              <Plus /> {preset.title}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Directories on this machine a pipeline may run in (`source: worker_workspace`).
 *
 * A declaration may be bound to a project — and then only that project's specs may name it, by key
 * *or* by the bare path. Left shared it behaves as it always did, which is why «общая» is the
 * default and not an oversight.
 */
function WorkspacesTab({ worker, projects, busy, readOnly, onSave }: {
  worker: WorkerRow;
  projects: Array<{ id: string; name: string }>;
  busy: boolean;
  readOnly: boolean;
  onSave: (workspaces: WorkerWorkspace[]) => void;
}) {
  const workspaces = worker.workspaces ?? [];
  const [key, setKey] = React.useState('');
  const [path, setPath] = React.useState('');
  const [projectId, setProjectId] = React.useState(NO_PROJECT);
  const [push, setPush] = React.useState(false);
  const [remote, setRemote] = React.useState('origin');

  const add = () => {
    const trimmedKey = key.trim();
    const trimmedPath = path.trim();
    if (!trimmedKey || !trimmedPath) return;
    // Adding an existing key replaces it — the only way to edit a declaration, and the behaviour
    // this form has always had. Whatever else the record carries (label, description written over
    // MCP) is kept rather than silently dropped.
    const previous = workspaces.find((item) => item.key === trimmedKey);
    onSave([
      ...workspaces.filter((item) => item.key !== trimmedKey),
      {
        ...(previous ?? {}),
        key: trimmedKey,
        path: trimmedPath,
        projectId: projectId === NO_PROJECT ? null : projectId,
        ...(push ? { git: { pushEnabled: true, remote: remote.trim() || 'origin' } } : { git: undefined }),
      },
    ]);
    setKey('');
    setPath('');
    setProjectId(NO_PROJECT);
    setPush(false);
    setRemote('origin');
  };

  return (
    <div className="space-y-4">
      {workspaces.length === 0 ? (
        <EmptyState
          title="Папок не объявлено"
          description="Пайплайн с источником «папка воркера» может назвать её ключом отсюда или абсолютным путём прямо в спеке."
        />
      ) : (
        <ul className="divide-y rounded-lg border">
          {workspaces.map((workspace) => (
            <li key={workspace.key} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <span className="w-40 shrink-0 truncate font-mono text-xs">{workspace.key}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{workspace.path}</span>
              <span className="w-44 shrink-0 truncate text-right text-xs text-muted-foreground">
                {workspace.projectId
                  ? `проект ${projects.find((project) => project.id === workspace.projectId)?.name ?? workspace.projectId}`
                  : 'общая'}
              </span>
              <span className="w-28 shrink-0 text-right text-xs text-muted-foreground">
                {workspace.git?.pushEnabled ? `пуш в ${workspace.git.remote ?? 'origin'}` : 'без пуша'}
              </span>
              {!readOnly && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  className="text-destructive"
                  onClick={() => onSave(workspaces.filter((item) => item.key !== workspace.key))}
                >
                  Убрать
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!readOnly && (
        <div className="rounded-lg border p-4">
          <h2 className="text-sm font-semibold">Объявить папку</h2>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Input value={key} onChange={(event: any) => setKey(event.target.value)} placeholder="ключ, напр. monorepo" className="h-8 w-52" />
            <Input value={path} onChange={(event: any) => setPath(event.target.value)} placeholder="/home/dev/projects/monorepo" className="h-8 w-80" />
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger size="sm" className="h-8 w-60"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PROJECT}>общая для всех проектов</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>только проект «{project.name}»</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant={push ? 'default' : 'outline'} size="sm" onClick={() => setPush((value) => !value)}>
              {push ? 'Git push разрешён' : 'Разрешить Git push'}
            </Button>
            {push && (
              <Input value={remote} onChange={(event: any) => setRemote(event.target.value)} placeholder="origin" className="h-8 w-28" />
            )}
            <Button size="sm" disabled={busy || !key.trim() || !path.trim()} onClick={add}>Добавить</Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Путь абсолютный и должен уже существовать на машине: воркер работает в готовом окружении и сам его не
            создаёт. Ключ — то, на что ссылается спека, поэтому путь менять можно, а ключ лучше сохранять; повторное
            добавление того же ключа заменяет запись. Папка, привязанная к проекту, закрыта для спек остальных
            проектов — и по ключу, и по голому пути.
          </p>
        </div>
      )}
    </div>
  );
}

/** Where on this machine a pipeline may commit and push from. Never a property of a spec. */
function GitTab({ worker, busy, readOnly, onSave }: {
  worker: WorkerRow;
  busy: boolean;
  readOnly: boolean;
  onSave: (roots: string[]) => void;
}) {
  const roots = worker.gitPushRoots ?? [];
  const [draft, setDraft] = React.useState('');
  const value = draft.trim();
  return (
    <div>
      <Section
        title="Откуда разрешён push"
        description="Право коммитить и пушить — свойство машины, а не спеки: спека может назвать любой путь, а git-креды лежат здесь. Разрешение действует на папку и на всё вложенное; «/» не принимается."
      >
        {roots.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Пуш не разрешён ниоткуда. Пайплайны могут работать в папках этой машины, но коммитить и пушить из них не смогут.
          </p>
        ) : (
          <Chips
            busy={busy}
            items={roots.map((root) => ({ id: root, label: root, hint: 'и всё внутри' }))}
            onRemove={readOnly ? undefined : (root) => onSave(roots.filter((item) => item !== root))}
          />
        )}
        {!readOnly && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Input value={draft} onChange={(event: any) => setDraft(event.target.value)} placeholder="/srv/projects" className="h-8 w-80" />
            <Button
              size="sm"
              disabled={busy || !value.startsWith('/') || value === '/'}
              onClick={() => { onSave(Array.from(new Set([...roots, value]))); setDraft(''); }}
            >
              Разрешить push
            </Button>
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Пуш идёт в remote <code className="font-mono">origin</code>. Другой remote можно назвать только у папки,
          объявленной по ключу (вкладка «Папки»).
        </p>
      </Section>

      <Section
        title="Что воркер проверяет перед запуском"
        description="Порядок проверок в рабочей папке: git принимает каталог → дерево чистое → ветка не отсоединена → remote тот же → локальный HEAD совпадает с удалённым."
      >
        <p className="text-sm text-muted-foreground">
          Чужая незакоммиченная работа по умолчанию уезжает в <code className="font-mono">git stash</code>, а не
          останавливает запуск: забытый файл не должен ни ронять пайплайн, ни попадать в дифф агента. Отказ вместо
          stash включается в спеке (<code className="font-mono">source.workspace.stashDirty: false</code>).
        </p>
      </Section>
    </div>
  );
}

/**
 * The bindings of one machine: which harnesses live here, under which account, whether the gate is
 * open and what the last telemetry said. Rendering is generic — abstract windows plus opaque
 * provider meta — so a new harness needs no new display code.
 */
function HarnessesTab({ workerId, bindings, subscriptions, busy, readOnly, post }: {
  workerId: string;
  bindings: HarnessBinding[];
  subscriptions: Subscription[];
  busy: boolean;
  readOnly: boolean;
  post: (body: Record<string, unknown>, success?: string) => Promise<any>;
}) {
  const [newKey, setNewKey] = React.useState('');
  const [metaOpen, setMetaOpen] = React.useState<string | null>(null);

  const replace = (next: Array<{ harnessKey: string; subscriptionId?: string | null; enabled?: boolean; maxConcurrent?: number | null }>): void => {
    // The server replaces the whole binding list at once (same convention as workspaces), so every
    // change here is "the list as it should now be", never a delta.
    void post({
      _method: 'setWorkerHarnessBindings',
      workerId,
      harnessBindings: next.map((binding) => ({
        harnessKey: binding.harnessKey,
        subscriptionId: binding.subscriptionId ?? null,
        enabled: binding.enabled !== false,
        maxConcurrent: binding.maxConcurrent ?? null,
      })),
    }, 'Привязки сохранены');
  };

  const asInput = (binding: HarnessBinding) => ({
    harnessKey: binding.harnessKey,
    subscriptionId: binding.subscription?.id ?? null,
    enabled: binding.enabled,
    maxConcurrent: binding.maxConcurrent ?? null,
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Лимит принадлежит аккаунту: та же подписка может обслуживать несколько машин, и сигнал от любой из них
        закрывает всех. Авторизация — наоборот, свойство машины. Подписки целиком —{' '}
        <a href={href('harnesses')} className="underline">Обвязки и лимиты</a>.
      </p>

      {bindings.length === 0 ? (
        <EmptyState
          title="Привязок нет"
          description="Добавьте ключ обвязки (например claude) — сервер также заведёт привязку сам при первом сигнале о лимите."
        />
      ) : (
        <ul className="space-y-4">
          {bindings.map((binding) => {
            const subscription = binding.subscription;
            return (
              <li key={binding.harnessKey} className="rounded-lg border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded border px-1.5 py-0.5 font-mono text-sm">{binding.harnessKey}</code>
                  <StatusBadge status={binding.state} />
                  <span className="text-xs text-muted-foreground">
                    работ: {binding.runningJobs} · в очереди на эту машину: {binding.queuedJobs}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
                    {subscription ? subscription.name : 'без подписки — заведётся при первом сигнале'}
                  </span>
                </div>

                {binding.authState === 'expired' && <div className="mt-3"><AuthNote binding={binding} /></div>}

                {binding.state === 'exhausted' && subscription?.exhaustedUntil && (
                  <p className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
                    Лимит подписки исчерпан до {formatDateTime(subscription.exhaustedUntil)}
                    {remainingSuffix(subscription.exhaustedUntil)}. Работы не падают, а откладываются: закреплённая
                    за этой машиной ждёт сброса, свободная уходит на другой воркер.
                    {subscription.exhaustedReason ? ` Последний сигнал: ${subscription.exhaustedReason.slice(0, 200)}` : ''}
                  </p>
                )}

                {binding.accountMismatch && (
                  <p className="mt-3 rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm">
                    Аккаунт в телеметрии этой машины не совпадает с аккаунтом подписки — возможно, она залогинена не туда.
                  </p>
                )}

                <div className="mt-3">
                  <WindowList
                    windows={binding.latestSample?.windows?.length ? binding.latestSample.windows : subscription?.windows ?? []}
                    observedAt={binding.latestSample?.observedAt ?? null}
                  />
                </div>

                {!readOnly && (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Select
                      value={subscription?.id ?? NO_SUBSCRIPTION}
                      onValueChange={(value: string) => replace(bindings.map((item) => (
                        item.harnessKey === binding.harnessKey
                          ? { ...asInput(item), subscriptionId: value === NO_SUBSCRIPTION ? null : value }
                          : asInput(item)
                      )))}
                    >
                      <SelectTrigger size="sm" className="h-8 w-64"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_SUBSCRIPTION}>без подписки (создастся автоматически)</SelectItem>
                        {subscriptions.map((item) => (
                          <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => replace(bindings.map((item) => (
                        item.harnessKey === binding.harnessKey
                          ? { ...asInput(item), enabled: !binding.enabled }
                          : asInput(item)
                      )))}
                    >
                      {binding.enabled ? 'Выключить' : 'Включить'}
                    </Button>
                    {binding.state === 'exhausted' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => post({ _method: 'clearHarnessLimit', workerId, harnessKey: binding.harnessKey }, 'Лимит снят')}
                      >
                        Снять лимит
                      </Button>
                    ) : (
                      <MarkExhaustedForm
                        label="Закрыть до…"
                        busy={busy}
                        onSubmit={(until, reason) => post(
                          { _method: 'markHarnessExhausted', workerId, harnessKey: binding.harnessKey, until, reason },
                          'Подписка закрыта',
                        )}
                      />
                    )}
                    {binding.latestSample?.meta != null && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setMetaOpen(metaOpen === binding.harnessKey ? null : binding.harnessKey)}
                      >
                        {metaOpen === binding.harnessKey ? 'Скрыть meta' : 'Показать meta'}
                      </Button>
                    )}
                    <ConfirmButton
                      label="Убрать"
                      question={`Убрать привязку «${binding.harnessKey}» с этой машины?`}
                      busy={busy}
                      onConfirm={() => replace(bindings.filter((item) => item.harnessKey !== binding.harnessKey).map(asInput))}
                    />
                  </div>
                )}

                {metaOpen === binding.harnessKey && binding.latestSample?.meta != null && (
                  <pre className="mt-3 max-h-72 overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs">
                    {JSON.stringify(binding.latestSample.meta, null, 2)}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <Input value={newKey} onChange={(event: any) => setNewKey(event.target.value)} placeholder="ключ обвязки, напр. claude" className="h-8 w-64" />
          <Button
            size="sm"
            disabled={busy || !newKey.trim()}
            onClick={() => {
              replace([...bindings.map(asInput), { harnessKey: newKey.trim(), subscriptionId: null, enabled: true }]);
              setNewKey('');
            }}
          >
            <Plus /> Добавить привязку
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// «Обвязки и лимиты» — the accounts behind the fleet
// ---------------------------------------------------------------------------------------------

const PROVIDERS = [
  { value: 'anthropic', label: 'anthropic' },
  { value: 'openai', label: 'openai' },
  { value: 'other', label: 'other' },
];

export function HarnessesScreen({ initial }: { initial: WorkerFleet }) {
  useViewerTimezone();
  const { fleet, busy, stale, post } = useFleet(initial, { capacityEvery: 30_000 });
  const [name, setName] = React.useState('');
  const [provider, setProvider] = React.useState('anthropic');
  const [settingsOpen, setSettingsOpen] = React.useState<string | null>(null);

  const workerName = (id: string) => fleet.workers.find((worker) => worker.id === id)?.name ?? id;

  /** Which machines sit on a subscription, and which bindings have none at all. */
  const bindingsOf = (subscriptionId: string) => Object.entries(fleet.harnesses)
    .flatMap(([workerId, list]) => list.map((binding) => ({ workerId, binding })))
    .filter((entry) => entry.binding.subscription?.id === subscriptionId);

  const unassigned = Object.entries(fleet.harnesses)
    .flatMap(([workerId, list]) => list.map((binding) => ({ workerId, binding })))
    .filter((entry) => !entry.binding.subscription);

  const loggedOut = Object.entries(fleet.harnesses)
    .flatMap(([workerId, list]) => list.map((binding) => ({ workerId, binding })))
    .filter((entry) => entry.binding.authState === 'expired');

  return (
    <>
      <PageHeader
        title="Обвязки и лимиты"
        description="Подписка принадлежит аккаунту, а не машине: одна и та же может обслуживать несколько воркеров, и сигнал от любой из них закрывает всех. Секретов здесь нет — авторизация живёт на машинах воркеров."
        meta={[
          <span key="count">{fleet.subscriptions.length} {plural(fleet.subscriptions.length, 'подписка', 'подписки', 'подписок')}</span>,
          stale ? <span key="stale" className="agentiz-attention">не обновляется — сервер не отвечает</span> : null,
        ]}
      />

      {loggedOut.length > 0 && (
        <div className="mb-5 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-destructive">
            <KeyRound className="size-4" /> Нет входа на {loggedOut.length}{' '}
            {plural(loggedOut.length, 'машине', 'машинах', 'машинах')}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Это не лимит и не кончится само: авторизация лежит на машине воркера и продлевается только через браузер
            на ней. Времени возобновления у этого состояния нет — работы стоят в очереди, пока туда не войдут заново.
          </p>
          <ul className="mt-3 space-y-1 text-sm">
            {loggedOut.map(({ workerId, binding }) => (
              <li key={`${workerId}:${binding.harnessKey}`} className="flex flex-wrap items-center gap-2">
                <a href={href('worker', { workerId })} className="font-medium hover:underline">{workerName(workerId)}</a>
                <code className="font-mono text-xs">{binding.harnessKey}</code>
                <span className="text-xs text-muted-foreground">
                  {binding.authFailedSince ? `с ${formatDateTime(binding.authFailedSince)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {fleet.subscriptions.length === 0 ? (
        <EmptyState
          title="Подписок нет"
          description="Подписка заводится сама при первом сигнале о лимите — или здесь, если нужно задать расписание и пороги заранее."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {fleet.subscriptions.map((subscription) => {
            const users = bindingsOf(subscription.id);
            const idle = idleLimitsLabel(subscription.lastLimitChangeAt);
            return (
              <Card key={subscription.id}>
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="text-sm">{subscription.name}</CardTitle>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {[subscription.provider, subscription.authKind, subscription.accountId].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <StatusBadge status={subscription.exhausted ? 'exhausted' : 'active'} />
                  </div>
                </CardHeader>
                <CardContent className="space-y-4 pt-0">
                  {subscription.exhausted && (
                    <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                      <span>
                        Лимит исчерпан
                        {subscription.exhaustedUntil
                          ? ` до ${formatDateTime(subscription.exhaustedUntil)}${remainingSuffix(subscription.exhaustedUntil)}`
                          : ''}. Работы не падают, а откладываются: закреплённая ждёт сброса, свободная уходит
                        на другой воркер.
                        {subscription.exhaustedReason ? ` ${subscription.exhaustedReason.slice(0, 200)}` : ''}
                      </span>
                    </div>
                  )}

                  <WindowList windows={subscription.windows ?? []} />

                  <Separator />

                  <div className="space-y-0.5">
                    <KeyValue label="Воркеры">
                      {users.length === 0
                        ? 'ни одного'
                        : users.map((entry) => `${workerName(entry.workerId)} · ${entry.binding.harnessKey}`).join(', ')}
                    </KeyValue>
                    {/* Two clocks, two questions: one says the worker is still reporting, the
                        other how long the account's quota has not moved. */}
                    <KeyValue label="Телеметрия">
                      {subscription.lastSignalAt
                        ? `${ago(subscription.lastSignalAt)} назад${subscription.lastSignalSource ? ` · ${subscription.lastSignalSource}` : ''}`
                        : 'не приходила'}
                    </KeyValue>
                    <KeyValue label="Простой подписки">{idle ? `лимиты без изменений ${idle}` : 'изменений ещё не было'}</KeyValue>
                    <KeyValue label="Выравнивание сброса">{alignmentLabel(subscription)}</KeyValue>
                    {(subscription.alignResetEnabled || subscription.keepWindowsOpen) && (
                      <KeyValue label="Последний прогрев"><PokeNote subscription={subscription} /></KeyValue>
                    )}
                  </div>

                  {fleet.canManage && (
                    <div className="flex flex-wrap gap-2">
                      {subscription.exhausted ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => post({ _method: 'clearHarnessLimit', subscriptionId: subscription.id }, 'Лимит снят')}
                        >
                          Снять лимит
                        </Button>
                      ) : (
                        <MarkExhaustedForm
                          label="Закрыть до…"
                          busy={busy}
                          onSubmit={(until, reason) => post(
                            { _method: 'markHarnessExhausted', subscriptionId: subscription.id, until, reason },
                            'Подписка закрыта',
                          )}
                        />
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => setSettingsOpen(settingsOpen === subscription.id ? null : subscription.id)}
                      >
                        {settingsOpen === subscription.id ? 'Скрыть настройки' : 'Настроить окна'}
                      </Button>
                      <ConfirmButton
                        label="Удалить"
                        question={`Удалить подписку «${subscription.name}»? Привязки воркеров останутся без неё.`}
                        busy={busy}
                        onConfirm={() => post({ _method: 'deleteSubscription', subscriptionId: subscription.id }, 'Подписка удалена')}
                      />
                    </div>
                  )}

                  {settingsOpen === subscription.id && (
                    <SubscriptionSettingsForm
                      subscription={subscription}
                      busy={busy}
                      onSave={(values) => post({ _method: 'saveSubscription', id: subscription.id, values }, 'Настройки сохранены')}
                      onClose={() => setSettingsOpen(null)}
                    />
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {unassigned.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold">Привязки без подписки</h2>
          <p className="mb-3 text-sm text-muted-foreground">
            Машина заявила обвязку, но аккаунт за ней ещё не назван. Подписка заведётся сама при первом сигнале
            о лимите — до этого лимит такой обвязки никем не считается.
          </p>
          <ul className="divide-y rounded-lg border">
            {unassigned.map(({ workerId, binding }) => (
              <li key={`${workerId}:${binding.harnessKey}`} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                <a href={href('worker', { workerId })} className="font-medium hover:underline">{workerName(workerId)}</a>
                <code className="font-mono text-xs">{binding.harnessKey}</code>
                <StatusBadge status={binding.state} className="ml-auto" />
              </li>
            ))}
          </ul>
        </div>
      )}

      {fleet.canManage && (
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Input
            value={name}
            onChange={(event: any) => setName(event.target.value)}
            placeholder="Название, напр. Claude Max #1 (ivan)"
            className="h-8 w-72"
          />
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger size="sm" className="h-8 w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PROVIDERS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={busy || !name.trim()}
            onClick={() => {
              void post(
                { _method: 'saveSubscription', values: { name: name.trim(), provider, authKind: 'subscription' } },
                'Подписка создана',
              );
              setName('');
            }}
          >
            <Plus /> Новая подписка
          </Button>
        </div>
      )}
    </>
  );
}

const WEEK_DAYS = Object.entries(DAY_LABELS);

/**
 * The subscription's schedule, stop thresholds and reset alignment.
 *
 * Mounted only while open, so every opening starts from the subscription's current state. It sends
 * only the fields it owns: a cron `resetSchedule` (which only MCP can write) is left untouched
 * unless the weekly editor is switched on over it.
 *
 * Alignment is best-effort discipline over *when a window opens* — it never touches the gate and
 * does nothing at all without fresh telemetry. That is why the hint talks about ±1 hour instead of
 * promising the hour.
 */
function SubscriptionSettingsForm({ subscription, busy, onSave, onClose }: {
  subscription: Subscription;
  busy: boolean;
  onSave: (values: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const schedule = subscription.resetSchedule ?? null;
  const weekly = schedule?.kind === 'weekly' ? schedule : null;
  const isCron = schedule?.kind === 'cron';
  const policy = subscription.stopPolicy ?? {};
  const windowKeys = Array.from(new Set([
    ...(subscription.windows ?? []).map((window) => window.key),
    ...Object.keys(policy),
  ]));

  const [authKind, setAuthKind] = React.useState(subscription.authKind ?? 'none');
  const [weeklyOn, setWeeklyOn] = React.useState(Boolean(weekly));
  const [day, setDay] = React.useState(weekly?.day ?? 'mon');
  const [time, setTime] = React.useState(weekly?.time ?? '03:00');
  const [weeklyZone, setWeeklyZone] = React.useState(weekly?.timezone ?? viewerZone);
  const [thresholds, setThresholds] = React.useState<Record<string, string>>(() => Object.fromEntries(
    windowKeys.map((key) => [key, policy[key]?.pauseAtUsedPercent != null ? String(policy[key]!.pauseAtUsedPercent) : '']),
  ));
  const [alignOn, setAlignOn] = React.useState(Boolean(subscription.alignResetEnabled));
  const [alignHour, setAlignHour] = React.useState(subscription.alignResetHour != null ? String(subscription.alignResetHour) : '9');
  const [alignZone, setAlignZone] = React.useState(subscription.alignResetTimezone ?? viewerZone);
  const [chainOn, setChainOn] = React.useState(Boolean(subscription.keepWindowsOpen));

  const hour = Number(alignHour);
  const alignValid = !alignOn || (Number.isInteger(hour) && hour >= 0 && hour <= 23 && Boolean(alignZone.trim()));
  const thresholdsValid = Object.values(thresholds).every((value) => {
    if (!value.trim()) return true;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 1 && parsed <= 100;
  });
  const weeklyValid = !weeklyOn || (Boolean(weeklyZone.trim()) && /^\d{2}:\d{2}$/.test(time));

  const save = () => {
    const stopPolicy: Record<string, { pauseAtUsedPercent: number }> = {};
    for (const [key, value] of Object.entries(thresholds)) {
      if (value.trim()) stopPolicy[key] = { pauseAtUsedPercent: Number(value) };
    }
    const values: Record<string, unknown> = {
      authKind: authKind === 'none' ? null : authKind,
      stopPolicy: Object.keys(stopPolicy).length ? stopPolicy : null,
      alignResetEnabled: alignOn,
      alignResetHour: alignHour.trim() ? hour : null,
      alignResetTimezone: alignZone.trim() || null,
      keepWindowsOpen: chainOn,
    };
    if (weeklyOn) values.resetSchedule = { kind: 'weekly', day, time, timezone: weeklyZone.trim() };
    else if (!isCron) values.resetSchedule = null;
    onSave(values);
    onClose();
  };

  return (
    <div className="space-y-4 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Режим авторизации</span>
        <Select value={authKind} onValueChange={setAuthKind}>
          <SelectTrigger size="sm" className="h-8 w-60"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">не указан</SelectItem>
            <SelectItem value="subscription">subscription (окна 5 ч / неделя)</SelectItem>
            <SelectItem value="api-key">api-key (RPM/TPM)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant={weeklyOn ? 'default' : 'outline'} size="sm" onClick={() => setWeeklyOn((value) => !value)}>
            Недельный сброс
          </Button>
          {weeklyOn && (
            <>
              <Select value={day} onValueChange={setDay}>
                <SelectTrigger size="sm" className="h-8 w-24"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WEEK_DAYS.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input type="time" value={time} onChange={(event: any) => setTime(event.target.value)} className="h-8 w-28" />
              <Input value={weeklyZone} onChange={(event: any) => setWeeklyZone(event.target.value)} placeholder="Europe/Belgrade" className="h-8 w-52" />
            </>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Объявленный момент сброса: в это время гейт откроется сам.
          {isCron && !weeklyOn ? ' Сейчас настроен cron (через MCP) — форма его не трогает.' : ''}
        </p>
      </div>

      <div>
        <div className="font-medium">Пороги остановки</div>
        {windowKeys.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">Окна появятся после первой телеметрии этой подписки.</p>
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {windowKeys.map((key) => (
              <label key={key} className="flex items-center gap-1 text-xs">
                {(subscription.windows ?? []).find((window) => window.key === key)?.label ?? key}
                <Input
                  value={thresholds[key] ?? ''}
                  onChange={(event: any) => setThresholds((current) => ({ ...current, [key]: event.target.value }))}
                  placeholder="—"
                  className="h-8 w-16"
                />
                %
              </label>
            ))}
          </div>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          Заполнено — закрыть гейт при N % потраченного. Это единственный способ, которым совещательная телеметрия
          вообще что-то запрещает.
        </p>
      </div>

      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant={alignOn ? 'default' : 'outline'} size="sm" onClick={() => setAlignOn((value) => !value)}>
            Выравнивать сброс по часу
          </Button>
          {alignOn && (
            <>
              <Input value={alignHour} onChange={(event: any) => setAlignHour(event.target.value)} placeholder="9" className="h-8 w-16" />
              <span className="text-xs text-muted-foreground">:00, зона</span>
              <Input value={alignZone} onChange={(event: any) => setAlignZone(event.target.value)} placeholder="Europe/Belgrade" className="h-8 w-52" />
            </>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Best-effort и только через момент открытия окна: при непрерывной работе сброс попадёт в ±1 час от этого часа,
          при простое — ровно в него. Гейта лимита это не касается, и без свежей телеметрии не делает ничего.
        </p>
      </div>

      <div>
        <Button variant={chainOn ? 'default' : 'outline'} size="sm" onClick={() => setChainOn((value) => !value)}>
          Открывать окна подряд
        </Button>
        <p className="mt-1 text-xs text-muted-foreground">
          {alignOn
            ? 'Закрылось окно — сразу открываем следующее, кроме паузы ровно в 4 часа перед выровненным окном: сброс встаёт на выбранный час минута в минуту.'
            : 'Закрылось окно — сразу открываем следующее. Около пяти запросов в сутки на этот аккаунт, включая ночи без работы.'}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || !alignValid || !thresholdsValid || !weeklyValid} onClick={save}>Сохранить</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>Отмена</Button>
        {!alignValid && <span className="text-xs text-destructive">час — целое 0–23, зона обязательна</span>}
        {!thresholdsValid && <span className="text-xs text-destructive">порог — число 1–100</span>}
        {!weeklyValid && <span className="text-xs text-destructive">время — ЧЧ:ММ, зона обязательна</span>}
      </div>
    </div>
  );
}
