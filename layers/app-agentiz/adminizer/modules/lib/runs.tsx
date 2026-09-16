import * as React from 'react';
import { AlertTriangle, Check, CircleDashed, Loader2, MessageSquare, Square, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { href } from '../../../lib/panel/routeTree';
import DiffViewer from '../components/diff-viewer';
import { Filter, FilterBar, SearchInput } from './blocks';
import { ago, elapsed, plural, queryParam, setQueryParam, shortId } from './format';
import { HumanInputForm, AnsweredInput, type RunInteraction } from './humanInput';
import { EmptyState, Facts, Page, PageHeader } from './page';
import { StatusBadge, triggerLabel } from './status';
import { formatTokens, tokensTooltip, totalTokens, type TokenUsage } from './tokenUsage';
import { cn, toast } from './ui';
import { formatDateTime, useViewerTimezone } from './viewerTime';

/**
 * The two run screens: the board of runs and one run in full.
 *
 * They are one file because they are one subject — the board's row and the run's header answer the
 * same question at two levels of detail, and the status vocabulary, the elapsed time and the
 * address of a run have to agree between them.
 *
 * What is *not* here, deliberately: the words for a status (`lib/status.tsx`, one dictionary for
 * every entity in the panel), the answer form (`lib/humanInput.tsx`, shared with the inbox and
 * with what stage 9 deletes), and the diff renderer (`components/diff-viewer`, vendored and
 * unchanged). This file only arranges them.
 *
 * Every write it performs already existed and is already used by the screens it replaces:
 * `cancelRun`, `applyRunDiff`, the four proposal decisions and `answerInteraction`. The port adds
 * no verb — only a second, better place to reach the same ones.
 */

const PREFIX: string = (window as any).routePrefix ?? '/dashboard';
const RUNS_API = `${PREFIX}/agentiz-runs`;
const TASKS_API = `${PREFIX}/agentiz-tasks`;
const axios = (window as any).axios;

// ---------------------------------------------------------------------------------------------
// Wire shapes. What the server actually sends; anything absent renders as nothing, never as zero.
// ---------------------------------------------------------------------------------------------

export interface RunCard {
  id: string;
  status: string;
  trigger: string;
  createdAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  currentStageIndex: number;
  errorMessage?: string | null;
  resultSummary?: string | null;
  verdict?: 'pass' | 'fail' | null;
  waitingReason?: string | null;
  waitingUntil?: string | null;
  branch?: string | null;
  task?: { id: string; title: string } | null;
  project?: { id: string; name: string; slug: string } | null;
  pipeline?: { id: string; name: string | null } | null;
  stages: Array<{ stageIndex: number; role: string; status: string }>;
  job?: { status: string; lastError?: string | null; worker?: { id: string; name: string } | null } | null;
  pendingInteractions: number;
  lastLog?: { level: string; message: string; createdAt?: string } | null;
  usage?: TokenUsage | null;
}

export interface RunList {
  active: RunCard[];
  recent: RunCard[];
  /** Every run in scope, filter or no filter — so «25 показано» never reads as «25 всего». */
  total: number;
}

interface StageExecution {
  id: string;
  stageIndex: number;
  role: string;
  status: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  errorMessage?: string | null;
  output?: { usage?: TokenUsage } | null;
}

interface RunLogRow {
  id: string;
  level: string;
  message: string;
  stageExecutionId?: string | null;
  createdAt?: string;
}

/** A page of the log: the rows plus everything needed to ask for the next or the previous one. */
interface LogPage {
  logs: RunLogRow[];
  logsCursor: string | null;
  logsEarlierCursor: string | null;
  logsHasEarlier: boolean;
  logsHasMore: boolean;
}

interface RunDiff {
  id: string;
  baseSha: string | null;
  patch: string | null;
  ops: Array<Record<string, any>> | null;
  stats: { files?: number; insertions?: number; deletions?: number } | null;
  truncated: boolean;
  appliedAt: string | null;
  appliedCommitSha: string | null;
  revision?: number | null;
}

interface WorkspaceProposal {
  id: string;
  revision: number;
  status: string;
  workspacePath: string;
  /** Non-null while this proposal blocks every other run on its directory. */
  reservationKey?: string | null;
  baseSha: string | null;
  baseBranch: string | null;
  expectedTreeSha: string | null;
  targetMode: 'current' | 'new';
  targetBranch: string | null;
  commitMessage: string;
  lastError?: string | null;
  stashSha?: string | null;
  abandonedRef?: string | null;
  pushedCommitSha?: string | null;
}

interface RunDetails {
  run: {
    id: string;
    taskId: string;
    projectId: string;
    status: string;
    trigger: string;
    currentStageIndex: number;
    pipelineSpecId?: string | null;
    resultSummary?: string | null;
    verdict?: 'pass' | 'fail' | null;
    verdictReason?: string | null;
    responseUrl?: string | null;
    commitUrl?: string | null;
    branch?: string | null;
    errorMessage?: string | null;
    waitingReason?: string | null;
    waitingUntil?: string | null;
    executorOverride?: { workerId?: string; executorKey?: string; model?: string; reasoning?: string } | null;
    createdAt?: string;
    startedAt?: string | null;
    finishedAt?: string | null;
  };
  usage: TokenUsage | null;
  task: { id: string; title: string; status: string } | null;
  pipeline: { id: string; name: string } | null;
  job: {
    id: string;
    status: string;
    jobKind: string;
    lastError: string | null;
    harnessKey: string | null;
    worker: { id: string; name: string } | null;
  } | null;
  stages: StageExecution[];
  diff: RunDiff | null;
  interactions: RunInteraction[];
  proposal: WorkspaceProposal | null;
  revisions: RunDiff[];
  latestDiff: RunDiff | null;
}

/** A run is "in flight" in these states — the same three the server's board query groups by. */
const LIVE_RUN_STATUSES = ['pending', 'running', 'waiting_input'];

/**
 * Statuses in which nobody is reviewing anything and only a worker report could move the proposal
 * on — the states where a directory used to stay reserved with no button anywhere.
 */
const STUCK_PROPOSAL_STATUSES = ['working', 'continuing', 'apply_queued', 'applying', 'reset_queued', 'resetting'];

/**
 * Where the escape hatch is offered: the safe release has either already failed or is waiting on a
 * worker that may never answer. Deliberately not on `waiting_review` — there the ordinary reject
 * does the same thing properly, and forcing would only leave the directory dirty for no reason.
 */
const FORCEABLE_PROPOSAL_STATUSES = [...STUCK_PROPOSAL_STATUSES, 'push_failed', 'reset_failed'];

/** A proposal in one of these has been decided; nothing will move it again. */
const SETTLED_PROPOSAL_STATUSES = ['pushed', 'rejected', 'released'];

/**
 * Why a run that has neither finished nor started is standing still. These are `waitingReason`
 * values, not statuses: the run keeps whatever status it had (AGENTS.md), and this is the only
 * place in the panel that says out loud what it is waiting for.
 */
const WAITING_REASONS: Record<string, { title: string; explain: string; timed: boolean }> = {
  harness_limit: {
    title: 'Ждёт сброса лимита обвязки',
    explain: 'Подписка исчерпана. Запуск не потерян — он стоит в очереди и продолжится сам, когда окно откроется.',
    timed: true,
  },
  harness_auth: {
    title: 'Воркер не авторизован в обвязке',
    explain:
      'Авторизация живёт на машине воркера и продлевается только через браузер — из Agentiz её не починить.'
      + ' Войдите в аккаунт обвязки на той машине; запуск продолжится сам через пару минут после входа.',
    timed: false,
  },
  schedule_window: {
    title: 'Ждёт рабочего окна',
    explain: 'Пайплайн или воркер ограничены рабочими часами. Запуск начнётся, когда окно откроется.',
    timed: true,
  },
};

// ---------------------------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------------------------

const STATUS_OPTIONS = [
  { value: 'all', label: 'Любой статус' },
  { value: 'running', label: 'Идут' },
  { value: 'waiting_input', label: 'Ждут ответа' },
  { value: 'pending', label: 'В очереди' },
  { value: 'succeeded', label: 'Успешные' },
  { value: 'failed', label: 'Упавшие' },
  { value: 'cancelled', label: 'Отменённые' },
];

/** Where a run row leads. `null` when its project is gone — a link `href` would throw on. */
function runHref(run: RunCard): string | null {
  return run.project?.slug ? href('project.run', { slug: run.project.slug, runId: run.id }) : null;
}

function RunRow({
  run,
  showProject,
  onCancel,
  busy,
}: {
  run: RunCard;
  showProject: boolean;
  onCancel: (run: RunCard) => void;
  busy: boolean;
}) {
  const live = LIVE_RUN_STATUSES.includes(run.status);
  const cancelled = run.status === 'cancelled';
  const link = runHref(run);
  const title = run.task?.title ?? 'Задача удалена';
  const waiting = run.waitingReason ? WAITING_REASONS[run.waitingReason] : null;

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-2.5 hover:bg-accent/40">
      <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{shortId(run.id)}</span>
      <StatusBadge status={run.status} className="w-32 shrink-0 justify-center" />
      <div className="min-w-0 flex-1">
        {link ? (
          <a href={link} className="block truncate text-sm font-medium hover:underline">{title}</a>
        ) : (
          <span className="block truncate text-sm font-medium">{title}</span>
        )}
        <p className="truncate text-xs text-muted-foreground">
          {/* A run with no `pipelineSpecId` is not a deleted pipeline — it predates the column, and
              saying otherwise sends somebody looking for a spec that was never there. */}
          {[
            showProject && run.project ? run.project.name : null,
            run.pipeline ? run.pipeline.name ?? 'пайплайн удалён' : null,
            run.job?.worker?.name ?? null,
            live ? `идёт ${elapsed(run.startedAt ?? run.createdAt)}` : formatDateTime(run.finishedAt ?? run.createdAt),
          ].filter(Boolean).join(' · ')}
        </p>
        {live && run.lastLog && (
          <p className="truncate text-xs text-muted-foreground/80" title={run.lastLog.message}>{run.lastLog.message}</p>
        )}
        {!live && run.errorMessage && (
          // A cancellation writes its reason into the same column as a failure; printing «Cancelled
          // by user» in red says something went wrong, and nothing did.
          <p className={cn('truncate text-xs', cancelled ? 'text-muted-foreground' : 'text-destructive')} title={run.errorMessage}>
            {run.errorMessage}
          </p>
        )}
      </div>
      {run.pendingInteractions > 0 && link && (
        <Badge asChild variant="outline" className="border-transparent bg-warning/20 agentiz-attention">
          <a href={link}>ждёт ответа</a>
        </Badge>
      )}
      {waiting && <Badge variant="outline" className="shrink-0">{waiting.title}</Badge>}
      {run.verdict && <StatusBadge status={run.verdict} className="shrink-0" />}
      <span className="w-44 shrink-0 truncate font-mono text-xs text-muted-foreground max-lg:hidden">
        {run.branch ?? '—'}
      </span>
      <span className="w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
        {elapsed(run.startedAt ?? run.createdAt, run.finishedAt)}
      </span>
      {live && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => onCancel(run)}>Остановить</Button>
      )}
    </li>
  );
}

function RunsTable({
  runs,
  showProject,
  onCancel,
  busyId,
}: {
  runs: RunCard[];
  showProject: boolean;
  onCancel: (run: RunCard) => void;
  busyId: string | null;
}) {
  return (
    <ul className="divide-y rounded-lg border">
      {runs.map((run) => (
        <RunRow key={run.id} run={run} showProject={showProject} onCancel={onCancel} busy={busyId === run.id} />
      ))}
    </ul>
  );
}

/**
 * «Запуски» — the board, global or inside one project.
 *
 * One screen for both, because the only difference is the scope of the query and whether a row
 * needs to name its project. It is server-rendered once and then polls: what it shows changes
 * without anybody touching the page, which is the whole reason to open it.
 */
export function RunsScreen({
  initial,
  projectId,
  initialStatus,
}: {
  initial: RunList;
  projectId: string | null;
  initialStatus: string;
}) {
  useViewerTimezone();
  const [list, setList] = React.useState<RunList>(initial);
  // An address may name a status that is not in the list (a hand-edited query, an enum value that
  // has since gone): the select would render blank on it. The list is what it can show.
  const [status, setStatus] = React.useState(
    STATUS_OPTIONS.some((option) => option.value === initialStatus) ? initialStatus : 'all',
  );
  const [search, setSearch] = React.useState('');
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [stale, setStale] = React.useState(false);

  const load = React.useCallback(async (nextStatus: string, quiet = false) => {
    try {
      const response = await axios.get(RUNS_API, {
        params: {
          _method: 'listRuns',
          projectId: projectId || undefined,
          status: nextStatus === 'all' ? undefined : nextStatus,
        },
      });
      setList(response.data?.data ?? { active: [], recent: [], total: 0 });
      setStale(false);
    } catch (error: any) {
      // A failed poll must not empty a list somebody is reading — it keeps the last good answer —
      // and it must not shout either: a server restarting mid-deploy would otherwise stack a toast
      // every three seconds. The screen says it is stale instead, once.
      setStale(true);
      if (!quiet) toast.error(error?.response?.data?.message ?? 'Не удалось обновить список запусков');
    }
  }, [projectId]);

  React.useEffect(() => {
    const timer = window.setInterval((): void => { void load(status, true); }, 3000);
    return (): void => { window.clearInterval(timer); };
  }, [load, status]);

  const applyStatus = (value: string) => {
    setStatus(value);
    setQueryParam('status', value === 'all' ? null : value);
    void load(value);
  };

  const cancel = React.useCallback(async (run: RunCard) => {
    setBusyId(run.id);
    try {
      await axios.post(RUNS_API, { _method: 'cancelRun', runId: run.id });
      toast.success('Запуск остановлен');
      await load(status);
    } catch (error: any) {
      toast.error(error?.response?.data?.message ?? 'Не удалось остановить запуск');
    } finally {
      setBusyId(null);
    }
  }, [load, status]);

  // Search is over what is loaded and says so in the header: the server already narrowed the list
  // by status, and a second round trip per keystroke would buy a promise this screen cannot keep.
  const needle = search.trim().toLowerCase();
  const matches = (run: RunCard) => !needle || [
    run.task?.title,
    run.branch,
    run.job?.worker?.name,
    run.pipeline?.name,
    run.project?.name,
    run.id,
  ].some((value) => (value ?? '').toLowerCase().includes(needle));

  const active = list.active.filter(matches);
  const recent = list.recent.filter(matches);
  const waiting = list.active.filter((run) => run.pendingInteractions > 0).length;
  const filtered = status !== 'all';

  return (
    <Page width="wide">
      <PageHeader
        title="Запуски"
        meta={[
          <span key="total">
            {list.total} {plural(list.total, 'запуск', 'запуска', 'запусков')} за всё время
          </span>,
          !projectId ? <span key="scope">по всем проектам</span> : null,
          list.active.length > 0 ? <span key="active">{list.active.length} идут сейчас</span> : null,
          waiting > 0 ? (
            <span key="waiting" className="agentiz-attention">
              {waiting} {plural(waiting, 'ждёт', 'ждут', 'ждут')} ответа
            </span>
          ) : null,
        ]}
      />

      <FilterBar>
        <SearchInput value={search} onChange={setSearch} placeholder="Задача, ветка, воркер, пайплайн" />
        <Filter value={status} onChange={applyStatus} options={STATUS_OPTIONS} />
        <span className="text-xs text-muted-foreground">
          {filtered
            ? `${active.length + recent.length} ${plural(active.length + recent.length, 'запуск', 'запуска', 'запусков')} с этим статусом`
            : 'идущие целиком, завершённые — последние 25'}
          {needle ? ' · поиск по загруженным строкам' : ''}
        </span>
        {stale && <span className="text-xs agentiz-attention">список не обновляется — сервер не отвечает</span>}
      </FilterBar>

      {active.length === 0 && recent.length === 0 ? (
        <EmptyState
          title="Запусков нет"
          description={needle || filtered ? 'Под этот фильтр ничего не подошло.' : 'Запустите пайплайн из задачи — запуск появится здесь.'}
        />
      ) : filtered ? (
        <RunsTable runs={[...active, ...recent]} showProject={!projectId} onCancel={cancel} busyId={busyId} />
      ) : (
        <div className="space-y-6">
          {active.length > 0 && (
            <div>
              <h2 className="mb-1.5 text-xs font-medium text-muted-foreground">Идут сейчас · {active.length}</h2>
              <RunsTable runs={active} showProject={!projectId} onCancel={cancel} busyId={busyId} />
            </div>
          )}
          {recent.length > 0 && (
            <div>
              <h2 className="mb-1.5 text-xs font-medium text-muted-foreground">Завершились</h2>
              <RunsTable runs={recent} showProject={!projectId} onCancel={cancel} busyId={busyId} />
            </div>
          )}
        </div>
      )}
    </Page>
  );
}

// ---------------------------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------------------------

const STAGE_ICONS: Record<string, React.ReactNode> = {
  succeeded: <Check className="size-4 text-chart-2" />,
  running: <Loader2 className="size-4 animate-spin text-chart-1" />,
  pending: <CircleDashed className="size-4 text-muted-foreground" />,
  failed: <X className="size-4 text-destructive" />,
  skipped: <CircleDashed className="size-4 text-muted-foreground" />,
};

/** `current` highlights the stage the run is *on*; pass -1 for a run that has finished. */
function StageList({ stages, current }: { stages: StageExecution[]; current: number }) {
  if (stages.length === 0) {
    return <EmptyState title="Этапов пока нет" description="Они появятся, когда воркер возьмёт работу." />;
  }
  return (
    <ol className="divide-y rounded-lg border">
      {stages.map((stage) => (
        <li key={stage.id} className={cn('px-4 py-3', stage.stageIndex === current && 'bg-accent/40')}>
          <div className="flex flex-wrap items-center gap-3">
            <span className="w-5 shrink-0 text-center">{STAGE_ICONS[stage.status] ?? STAGE_ICONS.pending}</span>
            <span className="w-6 shrink-0 text-xs text-muted-foreground tabular-nums">{stage.stageIndex + 1}</span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{stage.role}</span>
            {stage.output?.usage && totalTokens(stage.output.usage) > 0 && (
              <span className="text-xs text-muted-foreground" title={tokensTooltip(stage.output.usage)}>
                {formatTokens(totalTokens(stage.output.usage))} ткн
                {stage.output.usage.model ? ` · ${stage.output.usage.model}` : ''}
              </span>
            )}
            <span className="w-44 shrink-0 text-xs text-muted-foreground max-md:hidden">
              {stage.startedAt ? formatDateTime(stage.startedAt) : ''}
            </span>
            <span className="w-20 shrink-0 text-right text-sm text-muted-foreground tabular-nums">
              {stage.startedAt ? elapsed(stage.startedAt, stage.finishedAt) : '—'}
            </span>
          </div>
          {stage.errorMessage && <p className="mt-1 pl-8 text-xs text-destructive">{stage.errorMessage}</p>}
        </li>
      ))}
    </ol>
  );
}

const LOG_LEVEL_CLASS: Record<string, string> = {
  info: 'text-foreground',
  debug: 'text-muted-foreground',
  warn: 'agentiz-attention',
  error: 'text-destructive',
};

const LOG_LEVELS = [
  { value: 'all', label: 'Все строки' },
  { value: 'info', label: 'Только важное' },
  { value: 'debug', label: 'Инструменты агента' },
  { value: 'warn', label: 'Предупреждения' },
  { value: 'error', label: 'Ошибки' },
];

/** How close to the bottom still counts as "following the log" — a reader who scrolled up keeps
 *  their place instead of being yanked down by the next line. */
const AUTOSCROLL_SLACK_PX = 40;

function LogView({
  logs,
  hasEarlier,
  onLoadEarlier,
  timezone,
}: {
  logs: RunLogRow[];
  hasEarlier: boolean;
  onLoadEarlier: () => void;
  timezone: string | null;
}) {
  const [level, setLevel] = React.useState('all');
  const box = React.useRef<HTMLDivElement | null>(null);
  const following = React.useRef(true);
  const distanceFromBottom = React.useRef<number | null>(null);

  const shown = logs.filter((log) => level === 'all' || log.level === level);

  React.useEffect(() => {
    const element = box.current;
    if (!element) return;
    // "Показать более ранние" inserts above the viewport: keep the line the reader is looking at.
    if (distanceFromBottom.current !== null) {
      element.scrollTop = element.scrollHeight - distanceFromBottom.current;
      distanceFromBottom.current = null;
      return;
    }
    if (following.current) element.scrollTop = element.scrollHeight;
  }, [shown.length]);

  const time = (iso?: string) => {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    try {
      return date.toLocaleTimeString('ru-RU', { timeZone: timezone ?? undefined, hour12: false });
    } catch {
      return date.toLocaleTimeString('ru-RU', { hour12: false });
    }
  };

  return (
    <div>
      <FilterBar>
        <Filter value={level} onChange={setLevel} options={LOG_LEVELS} />
        {hasEarlier && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              distanceFromBottom.current = box.current ? box.current.scrollHeight - box.current.scrollTop : null;
              onLoadEarlier();
            }}
          >
            Показать более ранние
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          {shown.length} из {logs.length} {plural(logs.length, 'строки', 'строк', 'строк')} · первым показан хвост
        </span>
      </FilterBar>
      <div className="overflow-hidden rounded-lg border bg-muted/30">
        <div
          ref={box}
          onScroll={(event: React.UIEvent<HTMLDivElement>) => {
            const element = event.currentTarget;
            following.current = element.scrollHeight - element.scrollTop - element.clientHeight < AUTOSCROLL_SLACK_PX;
          }}
          className="max-h-[60vh] overflow-auto font-mono text-xs leading-relaxed"
        >
          {shown.map((log) => (
            <div key={log.id} className="flex gap-3 px-3 py-1 hover:bg-accent/50">
              <span className="shrink-0 text-muted-foreground tabular-nums">{time(log.createdAt)}</span>
              <span className="w-12 shrink-0 text-muted-foreground">{log.level}</span>
              <span className={cn('min-w-0 whitespace-pre-wrap break-words', LOG_LEVEL_CLASS[log.level])}>
                {log.message}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The change a run produced, and — while it is still held — the button that lets it through. */
function ChangesTab({ diff, canApply, onApply, busy }: {
  diff: RunDiff;
  canApply: boolean;
  onApply: () => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-4">
      <Facts
        items={[
          ['База', <code key="b" className="font-mono text-xs">{(diff.baseSha ?? '—').slice(0, 12)}</code>],
          ['Файлов', String(diff.stats?.files ?? diff.ops?.length ?? 0)],
          ['Строк', `+${diff.stats?.insertions ?? 0} −${diff.stats?.deletions ?? 0}`],
          [
            'В репозитории',
            diff.appliedAt
              ? `применено ${formatDateTime(diff.appliedAt)}, коммит ${(diff.appliedCommitSha ?? '').slice(0, 12)}`
              : 'не отправлено',
          ],
        ]}
      />

      {diff.truncated && (
        <p className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm agentiz-attention">
          Патч обрезан по лимиту размера — показан не весь. Операции сохранены полностью, применяются именно они.
        </p>
      )}

      {canApply && (
        <Button disabled={busy} onClick={onApply}>Применить в репозиторий</Button>
      )}

      {diff.patch ? (
        <DiffViewer patch={diff.patch} persistKey="agentiz.diffViewMode" />
      ) : (
        <ul className="space-y-0.5 rounded-lg border p-3 text-xs">
          {(diff.ops ?? []).map((op, index) => (
            <li key={index}>
              {/* One glyph per operation: the list is scanned, not read. */}
              <span className="mr-1 font-mono">{op.op === 'delete' ? '−' : op.op === 'rename' ? '→' : '~'}</span>
              <code>{op.op === 'rename' ? `${op.from} → ${op.to}` : op.path}</code>
              {op.mode && <span className="ml-1 text-muted-foreground">{op.mode}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The review of a `worker_workspace` change: what the worker is holding, and the decision.
 *
 * Three exits, and they are not the same thing. Approve commits and pushes; «продолжить работу»
 * sends remarks back and starts another round on the same directory; reject returns the directory
 * to its base — and the work is *not* lost, the worker stashes it first and reports the sha here.
 * The fourth button, «освободить», is not a review decision at all: it is the way out of the
 * statuses where nobody is reviewing anything and the directory would otherwise stay locked.
 */
function ReviewTab({
  proposal,
  revisions,
  diff,
  busy,
  onAction,
}: {
  proposal: WorkspaceProposal;
  revisions: RunDiff[];
  diff: RunDiff | null;
  busy: boolean;
  onAction: (method: string, extra?: Record<string, unknown>) => void;
}) {
  const [targetBranch, setTargetBranch] = React.useState(proposal.targetBranch ?? proposal.baseBranch ?? '');
  const [commitMessage, setCommitMessage] = React.useState(proposal.commitMessage ?? '');
  const [comment, setComment] = React.useState('');
  const settled = SETTLED_PROPOSAL_STATUSES.includes(proposal.status);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={proposal.status} />
        <span className="text-xs text-muted-foreground">ревизия {proposal.revision}</span>
        {proposal.reservationKey && (
          <span className="text-xs text-muted-foreground">
            папка <code className="font-mono">{proposal.workspacePath}</code> занята, пока решение не принято
          </span>
        )}
      </div>

      <Facts
        items={[
          ['Ветка', proposal.targetMode === 'current' ? `${proposal.baseBranch ?? '—'} (текущая)` : proposal.targetBranch ?? '—'],
          ['База', `${proposal.baseBranch ?? '—'}@${(proposal.baseSha ?? '—').slice(0, 12)}`],
          ['Папка', proposal.workspacePath],
          ['Файлов', String(diff?.stats?.files ?? diff?.ops?.length ?? 0)],
          ['Строк', `+${diff?.stats?.insertions ?? 0} −${diff?.stats?.deletions ?? 0}`],
          proposal.pushedCommitSha ? ['Коммит', proposal.pushedCommitSha.slice(0, 12)] : null,
        ]}
      />

      {proposal.lastError && (
        <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 font-mono text-xs text-destructive">
          {proposal.lastError}
        </p>
      )}

      {(proposal.stashSha || proposal.abandonedRef) && (
        <p className="rounded-lg border bg-muted/30 p-3 text-xs">
          Работа из отклонённой ревизии не потеряна — она лежит на воркере в{' '}
          <code className="font-mono">{proposal.workspacePath}</code>:
          {proposal.stashSha && <> <code className="font-mono">git stash apply {proposal.stashSha.slice(0, 12)}</code></>}
          {proposal.abandonedRef && <> коммит в <code className="font-mono">{proposal.abandonedRef}</code></>}
        </p>
      )}

      {revisions.length > 1 && (
        <p className="text-xs text-muted-foreground">
          История ревизий: {revisions.map((revision) => `#${revision.revision} — ${revision.stats?.files ?? 0} файл(ов)`).join(' · ')}
        </p>
      )}

      {proposal.status === 'waiting_review' && (
        <div className="space-y-4 rounded-lg border p-4">
          <div>
            <h3 className="text-sm font-semibold">Решение</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Принять — воркер закоммитит и запушит ветку. Отклонить — папка вернётся к базе, работа агента уедет
              в stash, и его sha появится в этой же карточке.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block text-xs font-medium">
              Ветка
              <Input
                className="mt-1"
                value={targetBranch}
                disabled={proposal.targetMode === 'current'}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setTargetBranch(event.target.value)}
              />
            </label>
            <label className="block text-xs font-medium">
              Commit message
              <Textarea
                className="mt-1"
                rows={3}
                value={commitMessage}
                onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setCommitMessage(event.target.value)}
              />
            </label>
          </div>
          <Button
            disabled={busy || diff?.truncated || !commitMessage.trim()}
            onClick={() => onAction('approveWorkspaceProposal', { targetBranch, commitMessage })}
          >
            Принять и запушить
          </Button>

          <Separator />

          <Textarea
            rows={3}
            value={comment}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setComment(event.target.value)}
            placeholder="Что доработать — этот текст агент получит как следующее указание"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy || !comment.trim()}
              onClick={() => onAction('continueWorkspaceProposal', { comment })}
            >
              Вернуть агенту с замечаниями
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => onAction('rejectWorkspaceProposal')}>
              Отклонить и вернуть папку
            </Button>
          </div>
          {!comment.trim() && (
            <p className="text-xs text-muted-foreground">
              Вернуть агенту без текста нельзя: ему нечего будет читать.
            </p>
          )}
        </div>
      )}

      {proposal.status === 'push_failed' && (
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => onAction('approveWorkspaceProposal', { targetBranch, commitMessage })}>
            Повторить push
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => onAction('rejectWorkspaceProposal')}>
            Вернуть папку
          </Button>
        </div>
      )}

      {proposal.status === 'reset_failed' && (
        <Button variant="destructive" disabled={busy} onClick={() => onAction('rejectWorkspaceProposal')}>
          Повторить безопасный reset
        </Button>
      )}

      {proposal.reservationKey && !settled && (
        <div className="space-y-2 border-t pt-4">
          <p className="text-xs text-muted-foreground">
            Пока это предложение не решено, <code className="font-mono">{proposal.workspacePath}</code> закрыт
            для всех остальных запусков — они падают с «Workspace is reserved by proposal».
          </p>
          <div className="flex flex-wrap gap-2">
            {STUCK_PROPOSAL_STATUSES.includes(proposal.status) && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => onAction('releaseWorkspaceProposal')}>
                Освободить папку
              </Button>
            )}
            {FORCEABLE_PROPOSAL_STATUSES.includes(proposal.status) && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => onAction('releaseWorkspaceProposal', { force: true })}>
                Снять резерв принудительно
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * «Запуск» — one run in full.
 *
 * The tabs are query parameters and change nothing on the server: a run that is streaming its log
 * must not lose it because somebody looked at the diff. What *is* a page load is the address of
 * the run itself, because the sidebar and the crumbs are per-request props.
 */
export function RunScreen({
  runId,
  slug,
  found,
}: {
  runId: string;
  slug: string;
  found: boolean;
}) {
  const timezone = useViewerTimezone();
  const [details, setDetails] = React.useState<RunDetails | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [tab, setTab] = React.useState(queryParam('tab') ?? 'overview');
  const [logs, setLogs] = React.useState<RunLogRow[]>([]);
  const [earlier, setEarlier] = React.useState<{ cursor: string | null; hasMore: boolean }>({ cursor: null, hasMore: false });
  const cursor = React.useRef<string | null>(null);

  const applyLogPage = React.useCallback((page: Partial<LogPage> | null, mode: 'reset' | 'append' | 'prepend') => {
    const rows = page?.logs ?? [];
    if (mode === 'reset') {
      setLogs(rows);
      setEarlier({ cursor: page?.logsEarlierCursor ?? null, hasMore: Boolean(page?.logsHasEarlier) });
    } else if (rows.length > 0) {
      // The same line can arrive twice when a "load earlier" page overlaps the tail already shown.
      setLogs((current) => {
        const known = new Set(current.map((log) => log.id));
        const fresh = rows.filter((log) => !known.has(log.id));
        return mode === 'append' ? [...current, ...fresh] : [...fresh, ...current];
      });
      if (mode === 'prepend') {
        setEarlier({ cursor: page?.logsEarlierCursor ?? null, hasMore: Boolean(page?.logsHasEarlier) });
      }
    } else if (mode === 'prepend') {
      setEarlier({ cursor: null, hasMore: false });
    }
    // A delta page with nothing in it carries no cursor — the previous one is still the position.
    if (mode !== 'prepend' && page?.logsCursor) cursor.current = page.logsCursor;
  }, []);

  const load = React.useCallback(async (options: { follow?: boolean; quiet?: boolean } = {}) => {
    // Only ask for the lines added since the last answer: the details payload carries the patch,
    // which can be megabytes, and re-reading it every 2.5 s to learn of three new lines is what
    // the cursor exists to avoid.
    const follow = options.follow === true && cursor.current !== null;
    try {
      const response = await axios.get(RUNS_API, {
        params: { _method: 'getRunDetails', runId, ...(follow ? { logsAfter: cursor.current } : {}) },
      });
      const next = response.data?.data ?? null;
      setDetails(next);
      applyLogPage(next, follow ? 'append' : 'reset');
      setFailed(false);
    } catch (error: any) {
      // The poll is quiet: a server restarting under a live run would otherwise raise a toast
      // every 2.5 s on top of the log somebody is reading. The header says it is stale instead.
      setFailed(true);
      if (!options.quiet) toast.error(error?.response?.data?.message ?? 'Не удалось загрузить запуск');
    }
  }, [applyLogPage, runId]);

  React.useEffect(() => {
    if (found) void load();
  }, [found, load]);

  const run = details?.run;
  const proposal = details?.proposal ?? null;
  const live = Boolean(run && LIVE_RUN_STATUSES.includes(run.status));
  // A finished run still moves while its proposal is undecided — the worker reports the push
  // minutes later. Once neither can change, polling stops instead of asking forever.
  const polls = live || Boolean(proposal && !SETTLED_PROPOSAL_STATUSES.includes(proposal.status));

  React.useEffect(() => {
    if (!found || !polls) return undefined;
    const timer = window.setInterval((): void => { void load({ follow: true, quiet: true }); }, 2500);
    return (): void => { window.clearInterval(timer); };
  }, [found, polls, load]);

  const loadEarlier = React.useCallback(async () => {
    if (!earlier.cursor) return;
    try {
      const response = await axios.get(RUNS_API, {
        params: { _method: 'getRunLogs', runId, before: earlier.cursor },
      });
      applyLogPage(response.data?.data ?? null, 'prepend');
    } catch (error: any) {
      toast.error(error?.response?.data?.message ?? 'Не удалось загрузить ранние строки');
    }
  }, [applyLogPage, earlier.cursor, runId]);

  const selectTab = (value: string) => {
    setTab(value);
    setQueryParam('tab', value === 'overview' ? null : value);
  };

  const post = async (body: Record<string, unknown>, success: string, url = RUNS_API) => {
    setBusy(true);
    try {
      const response = await axios.post(url, body);
      toast.success(success);
      await load();
      return response.data?.data ?? null;
    } catch (error: any) {
      toast.error(error?.response?.data?.message ?? 'Не получилось');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const proposalAction = async (method: string, extra: Record<string, unknown> = {}) => {
    if (!proposal) return;
    if (method === 'rejectWorkspaceProposal' && !window.confirm(
      `Каталог ${proposal.workspacePath} вернётся к ${(proposal.baseSha ?? '').slice(0, 12)}.`
      + ' Работа агента не пропадёт: воркер уберёт её в git stash, sha появится в этой же карточке.'
      + ' Игнорируемые файлы останутся на месте. Продолжить?',
    )) return;
    if (method === 'releaseWorkspaceProposal' && !window.confirm(extra.force
      ? `Резерв на ${proposal.workspacePath} будет снят немедленно, без участия воркера.`
        + ' Каталог никто не тронет — и не приберёт: незакоммиченная работа и служебный маркер останутся'
        + ' на машине как есть, stash сделать некому, и следующий запуск здесь будет падать, пока каталог'
        + ' не почистят руками. Так стоит делать, только если воркер уже не вернётся. Продолжить?'
      : `Текущая работа над ${proposal.workspacePath} будет остановлена, каталог возвращён к`
        + ` ${(proposal.baseSha ?? '').slice(0, 12)}, а всё несохранённое уйдёт в git stash.`
        + ' Резерв снимется, когда воркер отчитается. Продолжить?',
    )) return;

    const result = await post(
      { _method: method, proposalId: proposal.id, revision: proposal.revision, ...extra },
      'Решение принято',
    );
    // «Продолжить работу» answers with the *next* run: that is where the reader now belongs.
    if (method === 'continueWorkspaceProposal' && result?.id) {
      window.location.href = href('project.run', { slug, runId: result.id });
    }
  };

  if (!found) {
    return (
      <Page>
        <PageHeader title="Запуск" meta={<span className="font-mono">{shortId(runId)}</span>} />
        <EmptyState
          title="Запуск не найден"
          description="Он либо удалён, либо принадлежит другому проекту."
          action={<Button asChild variant="outline"><a href={href('project.runs', { slug })}>Все запуски проекта</a></Button>}
        />
      </Page>
    );
  }

  if (!run) {
    return (
      <Page>
        <PageHeader title="Запуск" meta={<span className="font-mono">{shortId(runId)}</span>} />
        {failed
          ? <EmptyState title="Не удалось загрузить запуск" description="Обновите страницу." />
          : <p className="text-sm text-muted-foreground">Загрузка…</p>}
      </Page>
    );
  }

  const pending = (details?.interactions ?? []).filter((interaction) => interaction.status === 'pending');
  const answered = (details?.interactions ?? []).filter((interaction) => interaction.status !== 'pending');
  const diff = proposal ? details?.latestDiff ?? null : details?.diff ?? null;
  const stages = details?.stages ?? [];
  // All stages still `pending` on a failed run means it never reached an agent: the error is
  // infrastructure, not the agent's output, and that changes where a person goes looking.
  const neverStarted = run.status === 'failed' && stages.length > 0 && stages.every((stage) => stage.status === 'pending');
  const waiting = run.waitingReason ? WAITING_REASONS[run.waitingReason] : null;
  const model = run.executorOverride?.model
    ?? [...stages].reverse().find((stage) => stage.output?.usage?.model)?.output?.usage?.model
    ?? null;
  const wide = tab === 'logs' || tab === 'changes';

  return (
    <Page width={wide ? 'wide' : 'default'}>
      <PageHeader
        title={<>Запуск <span className="font-mono">{shortId(run.id)}</span></>}
        meta={[
          <StatusBadge key="status" status={run.status} />,
          run.verdict ? <StatusBadge key="verdict" status={run.verdict} /> : null,
          details?.task ? (
            <a key="task" href={href('project.task', { slug, taskId: details.task.id })} className="hover:underline">
              {details.task.title}
            </a>
          ) : null,
          <span key="trigger">{triggerLabel(run.trigger)}</span>,
          <span key="created">{formatDateTime(run.createdAt)}</span>,
          failed ? <span key="stale" className="agentiz-attention">не обновляется — сервер не отвечает</span> : null,
        ]}
        actions={
          live ? (
            <Button variant="outline" disabled={busy} onClick={() => post({ _method: 'cancelRun', runId }, 'Запуск остановлен')}>
              <Square /> Остановить
            </Button>
          ) : details?.task ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                if (!window.confirm('Задача будет запущена заново — тем пайплайном, который подходит ей сейчас. Продолжить?')) return;
                void post({ _method: 'runTask', taskId: details.task!.id }, 'Запуск создан', TASKS_API).then((created) => {
                  if (created?.id) window.location.href = href('project.run', { slug, runId: created.id });
                });
              }}
            >
              Запустить заново
            </Button>
          ) : undefined
        }
        tabs={
          <Tabs value={tab} onValueChange={selectTab}>
            <TabsList>
              <TabsTrigger value="overview">Обзор</TabsTrigger>
              <TabsTrigger value="stages">
                Этапы <span className="ml-1.5 text-xs text-muted-foreground">{stages.length}</span>
              </TabsTrigger>
              <TabsTrigger value="logs">
                Лог <span className="ml-1.5 text-xs text-muted-foreground">{logs.length}</span>
              </TabsTrigger>
              <TabsTrigger value="changes" disabled={!diff}>
                Изменения
                {diff && <span className="ml-1.5 text-xs text-muted-foreground">{diff.stats?.files ?? diff.ops?.length ?? 0}</span>}
              </TabsTrigger>
              <TabsTrigger value="review" disabled={!proposal}>Ревью</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />

      {pending.map((interaction) => (
        <div key={interaction.id} className="mb-6 rounded-lg border border-warning/50 bg-warning/10 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <MessageSquare className="size-4 agentiz-attention" /> Запуск ждёт вашего ответа
            </div>
            <span className="text-xs text-muted-foreground">
              {stages.find((stage) => stage.id === interaction.stageExecutionId)?.role ?? 'этап'} · {interaction.source}
            </span>
          </div>
          <HumanInputForm interaction={interaction} onAnswered={() => load()} />
        </div>
      ))}

      {waiting && (
        <div className="mb-6 rounded-lg border border-warning/50 bg-warning/10 p-4">
          <div className="mb-1 flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="size-4 agentiz-attention" /> {waiting.title}
          </div>
          <p className="text-sm text-muted-foreground">
            {waiting.explain}
            {waiting.timed && run.waitingUntil ? ` Ожидание до ${formatDateTime(run.waitingUntil)}.` : ''}
          </p>
        </div>
      )}

      {run.status === 'failed' && run.errorMessage && (
        <div className="mb-6 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <div className="mb-1 flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="size-4 text-destructive" />
            {neverStarted ? 'Запуск не дошёл до агента' : 'Запуск завершился с ошибкой'}
          </div>
          <p className="font-mono text-xs text-destructive">{run.errorMessage}</p>
          {neverStarted && (
            <p className="mt-2 text-sm text-muted-foreground">
              Все этапы остались в состоянии «не начинался» — это отказ инфраструктуры, а не результат агента.
              Смотреть надо в лог запуска и в воркера, а не в вывод агента.
            </p>
          )}
        </div>
      )}

      {tab === 'overview' && (
        <div className="space-y-6">
          <Facts
            items={[
              ['Пайплайн', details?.pipeline?.name ?? '—'],
              ['Что запустило', triggerLabel(run.trigger)],
              ['Воркер', details?.job?.worker?.name ?? '—'],
              ['Обвязка', details?.job?.harnessKey ?? '—'],
              ['Модель', model ?? '—'],
              ['Ветка', run.branch ?? '—'],
              ['Начат', run.startedAt ? formatDateTime(run.startedAt) : '—'],
              ['Завершён', run.finishedAt ? formatDateTime(run.finishedAt) : '—'],
              ['Длительность', run.startedAt ? elapsed(run.startedAt, run.finishedAt) : '—'],
              [
                'Токены и стоимость',
                details?.usage && totalTokens(details.usage) > 0 ? (
                  <span title={tokensTooltip(details.usage)}>
                    {formatTokens(totalTokens(details.usage))} ткн
                    {details.usage.estimatedCostUsd
                      ? ` · ≈ $${details.usage.estimatedCostUsd.toFixed(details.usage.estimatedCostUsd < 0.1 ? 4 : 2)}`
                      : ''}
                  </span>
                ) : '—',
              ],
            ]}
          />

          {(run.commitUrl || run.responseUrl) && (
            <div className="flex flex-wrap gap-3 text-sm">
              {run.commitUrl && <a href={run.commitUrl} target="_blank" rel="noreferrer" className="underline">Коммит</a>}
              {run.responseUrl && <a href={run.responseUrl} target="_blank" rel="noreferrer" className="underline">Ответ в трекере</a>}
            </div>
          )}

          <Separator />

          <div>
            <h2 className="mb-2 text-sm font-semibold">Этапы</h2>
            <StageList stages={stages} current={live ? run.currentStageIndex : -1} />
          </div>

          {run.verdictReason && (
            <div>
              <h2 className="mb-2 text-sm font-semibold">Вердикт</h2>
              <p className="rounded-lg border bg-muted/30 p-4 text-sm">{run.verdictReason}</p>
            </div>
          )}

          {run.resultSummary && (
            <div>
              <h2 className="mb-2 text-sm font-semibold">Что сделал агент</h2>
              <p className="whitespace-pre-line rounded-lg border bg-muted/30 p-4 text-sm">{run.resultSummary}</p>
            </div>
          )}

          {answered.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-semibold">Отвеченные вопросы · {answered.length}</h2>
              <ul className="space-y-2">
                {answered.map((interaction) => (
                  <li key={interaction.id} className="rounded-lg border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={interaction.status} />
                      <span className="text-xs text-muted-foreground">
                        {interaction.source} · {ago(interaction.createdAt ?? null)} назад
                      </span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap">{interaction.message}</p>
                    <div className="mt-2"><AnsweredInput interaction={interaction} /></div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {tab === 'stages' && <StageList stages={stages} current={live ? run.currentStageIndex : -1} />}

      {tab === 'logs' && (
        logs.length === 0
          ? <EmptyState title="Лога нет" description={live ? 'Строки появятся, как только воркер начнёт работу.' : 'Этот запуск ничего не записал.'} />
          : <LogView logs={logs} hasEarlier={earlier.hasMore} onLoadEarlier={loadEarlier} timezone={timezone} />
      )}

      {tab === 'changes' && (
        diff ? (
          <ChangesTab
            diff={diff}
            // Only while the change is still held: applying twice is refused by the server, and a
            // button that always fails is worse than no button.
            canApply={!proposal && !diff.appliedAt && (diff.ops?.length ?? 0) > 0}
            busy={busy}
            onApply={() => {
              if (!window.confirm('Применить изменения в репозиторий? Повторно это сделать нельзя.')) return;
              void post({ _method: 'applyRunDiff', runId }, 'Изменения применены');
            }}
          />
        ) : (
          <EmptyState title="Этот запуск ничего не менял в коде" />
        )
      )}

      {tab === 'review' && proposal && (
        <ReviewTab
          proposal={proposal}
          revisions={details?.revisions ?? []}
          diff={diff}
          busy={busy}
          onAction={proposalAction}
        />
      )}
    </Page>
  );
}
