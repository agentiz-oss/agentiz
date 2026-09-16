import * as React from 'react';
import { AlertTriangle, ArrowUpRight, Paperclip, Play, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { href } from '../../../lib/panel/routeTree';
import { DEFAULT_TASK_VIEW, TASK_VIEWS, taskView, taskViewCount } from '../../../lib/taskViews';
import { Filter, FilterBar, SearchInput } from './blocks';
import { InboxDecision, type PanelInboxItem } from './inbox';
import { ago, plural, queryParam, setQueryParam, shortId } from './format';
import { EmptyState, Facts, Page, PageHeader } from './page';
import { StatusBadge, statusLabel, triggerLabel } from './status';
import { formatTokens } from './tokenUsage';
import { cn, toast } from './ui';
import { formatDateTime, useViewerTimezone } from './viewerTime';

/**
 * The two task screens: the board of a project's tasks and one task in full.
 *
 * They are one file for the same reason the two run screens are: the row and the header answer one
 * question at two levels of detail, and the tab vocabulary, the status words and the address of a
 * task have to agree between them. The board's right-hand card is the same task read shallowly, so
 * it reads the same payload the full screen does (`getTask`) instead of inventing a shorter one.
 *
 * What is deliberately **not** here:
 *
 * * the words for a status (`lib/status.tsx`) and for a tab (`lib/taskViews.ts`, shared with the
 *   server, which queries by exactly those statuses);
 * * what waits on a person — that is `actionRequired`, built by `lib/inbox/` and addressed by
 *   `lib/panel/inboxPanel.ts`, the same rows the inbox screen and the phone show. A task screen
 *   composing its own «агент ждёт ответа» out of its own fields is the third surface naming one
 *   event a third way, which is the whole reason that catalogue exists;
 * * the tail of the last run's log. The old screen printed it here as well as on the run screen;
 *   this one links to the run instead.
 *
 * Every write it performs already existed and is already used by the screen it replaces:
 * `createTask`, `updateTask`, `addComment`, `publishComment`, `pullComments`, `runTask`,
 * `cancelRun`, `deleteAttachment` and the raw upload POST.
 */

const PREFIX: string = (window as any).routePrefix ?? '/dashboard';
const TASKS_API = `${PREFIX}/agentiz-tasks`;
const axios = (window as any).axios;

// ---------------------------------------------------------------------------------------------
// Wire shapes. What the server actually sends; anything absent renders as nothing, never as zero.
// ---------------------------------------------------------------------------------------------

export interface TaskRow {
  id: string;
  projectId: string;
  externalId: string;
  /** The id the remote system uses; `externalId` is namespaced per source to avoid collisions. */
  remoteExternalId?: string | null;
  externalUrl?: string | null;
  title: string;
  status: string;
  priority: string;
  externalStatus?: string | null;
  /** Free text a workflow wrote, in the customer's language — never the `status` enum. */
  workflowStatus?: string | null;
  tags?: string[] | null;
  assigneeId?: number | null;
  sourceType?: string | null;
  sourceTitle?: string | null;
  sourceName?: string | null;
  sourceAvailable?: boolean;
  commentCount?: number;
  attachmentCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface TaskList {
  items: TaskRow[];
  /** Every task in scope under the current filters, tab or no tab — so «50 показано» is honest. */
  total: number;
  /** One entry per stored status; the tabs sum the ones they cover (`lib/taskViews.ts`). */
  statusCounts: Record<string, number>;
}

interface TaskAttachment {
  id: string;
  fileName: string;
  mimeType?: string | null;
  sizeBytes: number;
  uploadedByName?: string | null;
  createdAt?: string;
}

interface TaskComment {
  id: string;
  authorKind: 'human' | 'agent' | 'system';
  /** Where it was written: `remote` means it was pulled from the task's own tracker. */
  origin?: 'local' | 'remote';
  authorName?: string | null;
  runId?: string | null;
  body: string;
  externalUrl?: string | null;
  externalCreatedAt?: string | null;
  createdAt?: string;
}

interface TaskRunRow {
  id: string;
  status: string;
  trigger: string;
  triggerCommentId?: string | null;
  previousRunId?: string | null;
  createdAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  branch?: string | null;
  verdict?: 'pass' | 'fail' | null;
  errorMessage?: string | null;
  resultSummary?: string | null;
  usageTotalTokens?: number | string | null;
}

/** What a manual launch may choose, and what it gets untouched — `lib/runOptions.ts`. */
interface RunOptions {
  pipeline?: { id: string; name: string } | null;
  defaults: { harnessKey: string | null; harnessTitle: string | null; model: string | null };
  executors: Array<{ workerId: string; executorKey: string; title: string; workerName: string; harnessKey: string | null }>;
  harnesses: Array<{ key: string; title: string; models: Array<{ id: string; title: string }>; reasoningLevels: string[] }>;
  reasoningLevels: Array<{ value: string; title: string }>;
}

/**
 * «Не переопределять» as a select value.
 *
 * Deliberately not an empty string: the panel's `Select` is Radix, and a `SelectItem` with an empty
 * value throws outright — the control simply does not render. Anything sent to the server is
 * translated back to «absent» before it leaves this file.
 */
const KEEP = '__keep';

/** Null everywhere = run the pipeline exactly as configured, which is what the button did before. */
interface RunChoice {
  workerId?: string;
  executorKey?: string;
  model?: string;
  reasoningLevel?: string;
}

interface TaskWorkflow {
  status: string | null;
  statusAt?: string | null;
  currentRunId: string | null;
  rounds: number;
  approvals: Array<{
    id: string;
    status: string;
    title: string;
    message?: string | null;
    decisionComment?: string | null;
    decidedAt?: string | null;
    createdAt?: string;
  }>;
}

export interface TaskDetails {
  task: TaskRow & { description?: string | null; canPullComments?: boolean };
  project: { id: string; name: string; slug: string } | null;
  source: { id: string; name: string; type: string; isActive: boolean } | null;
  runs: TaskRunRow[];
  comments: TaskComment[];
  attachments: TaskAttachment[];
  /** Absent when the project has no active pipeline spec — then nothing can be launched at all. */
  runOptions?: RunOptions | null;
  workflow?: TaskWorkflow;
  /** Everything waiting on a person inside this task, from `lib/inbox/`. */
  actionRequired?: PanelInboxItem[];
}

/** A task whose pipeline still owns it — the board keeps polling while any row is in one of these. */
const LIVE_TASK_STATUSES = ['queued', 'running', 'waiting_input', 'waiting_review'];

/** A run nobody can stop any more. */
const TERMINAL_RUN_STATUSES = ['succeeded', 'failed', 'cancelled'];

const PRIORITY_LABELS: Record<string, string> = {
  low: 'Низкий',
  normal: 'Обычный',
  high: 'Высокий',
  urgent: 'Срочный',
};

const PRIORITY_OPTIONS = [
  { value: 'all', label: 'Любой приоритет' },
  ...['urgent', 'high', 'normal', 'low'].map((value) => ({ value, label: PRIORITY_LABELS[value] })),
];

const AUTHOR_LABELS: Record<string, string> = { human: 'человек', agent: 'агент', system: 'система' };

// ---------------------------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------------------------

/** The number a person quotes: the tracker's own id where there is one, ours otherwise. */
function taskNumber(task: TaskRow): string {
  if (task.sourceType && task.sourceType !== 'local' && task.remoteExternalId) return `#${task.remoteExternalId}`;
  return shortId(task.id);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

const attachmentUrl = (id: string, inline = false) =>
  `${TASKS_API}?_method=downloadAttachment&attachmentId=${encodeURIComponent(id)}${inline ? '&inline=1' : ''}`;

const isImage = (attachment: TaskAttachment) => (attachment.mimeType ?? '').startsWith('image/');

/** One file, as a raw body: the name and the task travel in the query (see `taskRoutes.ts`). */
async function uploadAttachment(taskId: string, file: File): Promise<void> {
  await axios.post(
    `${TASKS_API}/attachments?taskId=${encodeURIComponent(taskId)}&fileName=${encodeURIComponent(file.name)}`,
    file,
    { headers: { 'Content-Type': file.type || 'application/octet-stream' } },
  );
}

/**
 * Files are uploaded one request at a time so an oversized one fails alone and the rest still land;
 * that is also what gives the caller per-file progress for free.
 */
async function uploadFiles(taskId: string, files: File[] | FileList, onProgress: (text: string | null) => void): Promise<boolean> {
  const list = Array.from(files);
  if (list.length === 0) return true;
  for (const [index, file] of list.entries()) {
    onProgress(`Загрузка ${index + 1} из ${list.length}: ${file.name}`);
    try {
      await uploadAttachment(taskId, file);
    } catch (error: any) {
      onProgress(null);
      toast.error(error?.response?.data?.message ?? `Не удалось загрузить «${file.name}»`);
      return false;
    }
  }
  onProgress(null);
  toast.success(list.length === 1 ? `Файл «${list[0].name}» прикреплён` : `Прикреплено файлов: ${list.length}`);
  return true;
}

/**
 * One task's payload, and the one way this file asks for it.
 *
 * The board's side card and the full screen read the same endpoint: a shorter card-only payload
 * would be a second shape of the same task, and the first thing that drifts between two shapes is
 * which of them knows about a new field.
 */
function useTaskDetails(taskId: string | null) {
  const [details, setDetails] = React.useState<TaskDetails | null>(null);
  const [failed, setFailed] = React.useState(false);

  const load = React.useCallback(async (options: { quiet?: boolean } = {}) => {
    if (!taskId) {
      setDetails(null);
      return;
    }
    try {
      const response = await axios.get(TASKS_API, { params: { _method: 'getTask', taskId } });
      setDetails(response.data?.data ?? null);
      setFailed(false);
    } catch (error: any) {
      // Quiet on a poll: a server restarting under an open task would otherwise stack a toast
      // every few seconds on top of the thread somebody is reading.
      setFailed(true);
      if (!options.quiet) toast.error(error?.response?.data?.message ?? 'Не удалось загрузить задачу');
    }
  }, [taskId]);

  React.useEffect(() => {
    setDetails(null);
    setFailed(false);
    void load();
  }, [load]);

  return { details, failed, reload: load };
}

/** POSTs to the task endpoint, reports the outcome and hands back what the server answered. */
async function post(body: Record<string, unknown>, success?: string): Promise<any> {
  try {
    const response = await axios.post(TASKS_API, body);
    if (success) toast.success(success);
    return response.data?.data ?? null;
  } catch (error: any) {
    toast.error(error?.response?.data?.message ?? 'Не получилось');
    return null;
  }
}

/** Comma-separated tags, the way a person types them. Empty entries are dropped, not stored. */
function parseTags(value: string): string[] {
  return value.split(',').map((tag) => tag.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// «Требует внимания»
// ---------------------------------------------------------------------------------------------

/**
 * What waits on a person inside this task, in the server's own words.
 *
 * Every field printed here — the badge, the headline, the explanation, the facts and the captions
 * on the buttons — comes from `lib/inbox/items.ts`; this component only arranges them and hands
 * the buttons to `InboxDecision`, which is the same code the inbox screen presses.
 */
function AttentionStrip({ items, onDone }: { items: PanelInboxItem[]; onDone: () => void }) {
  if (items.length === 0) return null;
  return (
    <div className="mb-6 space-y-3">
      {items.map((item) => (
        <div key={item.id} className="rounded-lg border border-warning/50 bg-warning/10 p-4">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-sm font-medium">
            <AlertTriangle className="size-4 agentiz-attention" />
            {item.badge}
            {item.waitingSince && <span className="text-xs font-normal text-muted-foreground">ждёт {ago(item.waitingSince)}</span>}
          </div>
          <p className="text-sm">{item.headline}</p>
          {item.explain && <p className="mt-1 text-sm text-muted-foreground">{item.explain}</p>}
          {item.facts && (
            <p className="mt-2 rounded border bg-background/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">
              {item.facts}
            </p>
          )}
          <div className="mt-3">
            <InboxDecision item={item} onDone={onDone} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The launch dialog
// ---------------------------------------------------------------------------------------------

/**
 * «Запустить» — the three things a manual launch may overrule, and nothing else.
 *
 * The runner is also a worker pin (only that machine has that executor installed); the model and
 * the thinking level pin nothing and apply to every stage. What the lists offer is advisory
 * vocabulary from `lib/harnessCatalog.ts`, never a whitelist — a model id it does not know is still
 * legal and can be set over MCP — so nothing here refuses a launch because of it.
 */
function RunDialog({
  open,
  onOpenChange,
  details,
  onLaunched,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  details: TaskDetails;
  onLaunched: (runId: string | null) => void;
}) {
  const [choice, setChoice] = React.useState<RunChoice>({});
  const [busy, setBusy] = React.useState(false);
  const options = details.runOptions ?? null;

  const executor = (options?.executors ?? []).find(
    (item) => item.workerId === choice.workerId && item.executorKey === choice.executorKey,
  ) ?? null;
  // A chosen runner decides the model list; with none chosen that is the pipeline's own harness.
  const harness = (options?.harnesses ?? []).find(
    (item) => item.key === (executor?.harnessKey ?? options?.defaults.harnessKey ?? null),
  ) ?? null;
  // A model left over from another harness would be sent to a CLI that does not know it.
  const model = !choice.model || !harness || harness.models.length === 0
    || harness.models.some((option) => option.id === choice.model)
    ? choice.model
    : undefined;

  const executorOptions = [
    { value: KEEP, label: 'Обвязка по пайплайну' },
    ...(options?.executors ?? []).map((option) => ({
      value: `${option.workerId}:${option.executorKey}`,
      label: `${option.title} · ${option.workerName}`,
    })),
  ];
  const modelOptions = [
    { value: KEEP, label: `Модель по пайплайну${options?.defaults.model ? ` (${options.defaults.model})` : ''}` },
    ...(harness?.models ?? []).map((option) => ({ value: option.id, label: option.title })),
  ];
  const levelOptions = [
    { value: KEEP, label: 'Уровень как у CLI' },
    ...(options?.reasoningLevels ?? [])
      .filter((level) => !harness || harness.reasoningLevels.length === 0 || harness.reasoningLevels.includes(level.value))
      .map((level) => ({ value: level.value, label: level.title })),
  ];

  const launch = async () => {
    setBusy(true);
    const run = await post({
      _method: 'runTask',
      taskId: details.task.id,
      workerId: executor?.workerId,
      executorKey: executor?.executorKey,
      model,
      reasoningLevel: choice.reasoningLevel,
    }, 'Пайплайн запущен');
    setBusy(false);
    if (run) {
      onOpenChange(false);
      onLaunched(run.id ?? null);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Запустить пайплайн</SheetTitle>
          <SheetDescription>
            {options?.pipeline
              ? `Задача пойдёт по пайплайну «${options.pipeline.name}» — он подобран по её тегам.`
              : 'У проекта нет активного пайплайна, запускать нечего.'}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4">
          <label className="block text-sm font-medium">
            Обвязка
            <Filter
              className="mt-1.5 w-full"
              value={choice.workerId ? `${choice.workerId}:${choice.executorKey}` : KEEP}
              onChange={(value: string) => {
                const picked = (options?.executors ?? []).find((item) => `${item.workerId}:${item.executorKey}` === value);
                // Switching runners drops a model picked for the previous one: model ids are
                // harness vocabulary, and «gpt-5.5» sent to Claude is a failed run.
                setChoice((current) => ({
                  ...current,
                  workerId: picked?.workerId,
                  executorKey: picked?.executorKey,
                  model: undefined,
                }));
              }}
              options={executorOptions}
            />
            <span className="mt-1 block text-xs font-normal text-muted-foreground">
              Выбор обвязки закрепляет запуск за этой машиной — исполнитель установлен не везде.
            </span>
          </label>

          {modelOptions.length > 1 && (
            <label className="block text-sm font-medium">
              Модель
              <Filter
                className="mt-1.5 w-full"
                value={model ?? KEEP}
                onChange={(value: string) => setChoice((current) => ({ ...current, model: value === KEEP ? undefined : value }))}
                options={modelOptions}
              />
              <span className="mt-1 block text-xs font-normal text-muted-foreground">
                Применяется ко всем этапам этого запуска и не сохраняется в спеку.
              </span>
            </label>
          )}

          {levelOptions.length > 1 && (
            <label className="block text-sm font-medium">
              Уровень рассуждений
              <Filter
                className="mt-1.5 w-full"
                value={choice.reasoningLevel ?? KEEP}
                onChange={(value: string) => setChoice((current) => ({ ...current, reasoningLevel: value === KEEP ? undefined : value }))}
                options={levelOptions}
              />
            </label>
          )}

          <p className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
            Запустится: {[
              executor?.title ?? options?.defaults.harnessTitle ?? 'обвязка по пайплайну',
              model ?? options?.defaults.model ?? 'модель по умолчанию',
              `уровень: ${(options?.reasoningLevels ?? []).find((level) => level.value === choice.reasoningLevel)?.title.toLowerCase() ?? 'как у CLI'}`,
            ].join(' · ')}
          </p>
        </div>
        <SheetFooter>
          <Button disabled={busy || !options} onClick={launch}><Play /> Запустить</Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Отмена</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------------------------

function TaskRowView({ task, selected, onSelect }: { task: TaskRow; selected: boolean; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn('flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/40', selected && 'bg-accent')}
      >
        <span className="w-20 shrink-0 truncate font-mono text-xs text-muted-foreground">{taskNumber(task)}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{task.title}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {/* Free text a workflow wrote, beside the enum and never instead of it. */}
            {task.workflowStatus && <span className="truncate">{task.workflowStatus}</span>}
            {(task.tags ?? []).map((tag) => (
              <span key={tag} className="rounded bg-muted px-1.5">{tag}</span>
            ))}
            {(task.commentCount ?? 0) > 0 && <span>💬 {task.commentCount}</span>}
            {(task.attachmentCount ?? 0) > 0 && <span>📎 {task.attachmentCount}</span>}
          </span>
        </span>
        <StatusBadge status={task.status} className="w-32 shrink-0 justify-center" />
        <span className="w-24 shrink-0 text-xs text-muted-foreground max-xl:hidden">
          {PRIORITY_LABELS[task.priority] ?? task.priority}
        </span>
        <span className="w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
          {ago(task.updatedAt)}
        </span>
      </button>
    </li>
  );
}

/** The board's right-hand card: the task read shallowly, with the way into it. */
function TaskCard({ taskId, slug, onChanged }: { taskId: string; slug: string; onChanged: () => void }) {
  const { details, failed, reload } = useTaskDetails(taskId);
  const [runOpen, setRunOpen] = React.useState(false);

  if (!details) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          {failed ? 'Не удалось загрузить задачу.' : 'Загрузка…'}
        </CardContent>
      </Card>
    );
  }

  const link = href('project.task', { slug, taskId });
  const waiting = details.actionRequired ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-sm">
              <a href={link} className="hover:underline">
                <span className="font-mono text-muted-foreground">{taskNumber(details.task)}</span> {details.task.title}
              </a>
            </CardTitle>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <StatusBadge status={details.task.status} />
              {details.task.workflowStatus && (
                <span className="text-xs text-muted-foreground">{details.task.workflowStatus}</span>
              )}
            </div>
          </div>
          <a href={link} title="открыть целиком"><ArrowUpRight className="size-4 text-muted-foreground" /></a>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        {waiting.length > 0 && (
          <div className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm">
            <div className="font-medium">{waiting[0].badge}</div>
            <p className="mt-0.5 text-muted-foreground">{waiting[0].headline}</p>
            {waiting.length > 1 && (
              <p className="mt-1 text-xs text-muted-foreground">
                и ещё {waiting.length - 1} {plural(waiting.length - 1, 'строка', 'строки', 'строк')} — на экране задачи
              </p>
            )}
          </div>
        )}

        <p className="whitespace-pre-line text-sm text-muted-foreground">
          {details.task.description || 'Без описания.'}
        </p>

        <Facts
          items={[
            ['Пайплайн', details.runOptions?.pipeline?.name ?? '—'],
            ['Источник', details.task.sourceName ?? details.task.sourceTitle ?? 'вручную'],
            ['Запусков', String(details.runs.length)],
          ]}
        />

        {details.runs.length > 0 && (
          <div>
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">Запуски</div>
            <ul className="divide-y rounded border">
              {details.runs.slice(0, 5).map((run) => (
                <li key={run.id} className="flex items-center gap-2 px-3 py-2">
                  <a href={href('project.run', { slug, runId: run.id })} className="font-mono text-xs hover:underline">
                    {shortId(run.id)}
                  </a>
                  <StatusBadge status={run.status} className="ml-auto" />
                  <span className="w-20 text-right text-xs text-muted-foreground">{ago(run.createdAt)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setRunOpen(true)}><Play /> Запустить</Button>
          <Button asChild size="sm" variant="outline"><a href={link}>Открыть целиком</a></Button>
        </div>
      </CardContent>

      {/* Mounted only while it is open, so every launch starts from the pipeline's own settings
          rather than from what somebody picked for the previous task. */}
      {runOpen && (
        <RunDialog
          open
          onOpenChange={setRunOpen}
          details={details}
          onLaunched={(runId) => {
            void reload();
            onChanged();
            if (runId) window.location.href = href('project.run', { slug, runId });
          }}
        />
      )}
    </Card>
  );
}

/** «Новая задача» — the form the board's button opens. Files are attached once the task exists. */
function NewTaskSheet({
  open,
  onOpenChange,
  projectId,
  priorities,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  priorities: string[];
  onCreated: (taskId: string) => void;
}) {
  const [form, setForm] = React.useState({ title: '', description: '', priority: 'normal', tags: '' });
  const [files, setFiles] = React.useState<File[]>([]);
  const [progress, setProgress] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const picker = React.useRef<HTMLInputElement | null>(null);

  const submit = async () => {
    if (!form.title.trim()) {
      toast.error('Укажите заголовок');
      return;
    }
    setBusy(true);
    const created = await post({
      _method: 'createTask',
      projectId,
      title: form.title,
      description: form.description,
      priority: form.priority,
      tags: parseTags(form.tags),
    }, 'Задача создана');
    if (created?.id && files.length > 0) await uploadFiles(created.id, files, setProgress);
    setBusy(false);
    if (created?.id) {
      setForm({ title: '', description: '', priority: 'normal', tags: '' });
      setFiles([]);
      onOpenChange(false);
      onCreated(created.id);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Новая задача</SheetTitle>
          <SheetDescription>Пайплайн подберётся по тегам — выбирать его здесь не нужно.</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4">
          <label className="block text-sm font-medium">
            Название
            <Input
              className="mt-1.5"
              value={form.title}
              placeholder="Что нужно сделать"
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, title: event.target.value })}
            />
          </label>
          <label className="block text-sm font-medium">
            Описание
            <Textarea
              className="mt-1.5"
              rows={6}
              value={form.description}
              placeholder="Контекст, шаги воспроизведения, ссылки"
              onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setForm({ ...form, description: event.target.value })}
            />
          </label>
          <label className="block text-sm font-medium">
            Теги
            <Input
              className="mt-1.5"
              value={form.tags}
              placeholder="фича, баг"
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, tags: event.target.value })}
            />
            <span className="mt-1 block text-xs font-normal text-muted-foreground">
              Через запятую. По тегам выбирается пайплайн.
            </span>
          </label>
          <label className="block text-sm font-medium">
            Приоритет
            <Filter
              className="mt-1.5 w-full"
              value={form.priority}
              onChange={(value: string) => setForm({ ...form, priority: value })}
              options={priorities.map((value) => ({ value, label: PRIORITY_LABELS[value] ?? value }))}
            />
          </label>

          <div>
            <input
              ref={picker}
              type="file"
              multiple
              className="sr-only"
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                // Snapshot before clearing `value`: the FileList is live and empties with it.
                const picked = Array.from(event.target.files ?? []);
                if (picked.length) setFiles((current) => [...current, ...picked]);
                event.target.value = '';
              }}
            />
            <Button variant="outline" size="sm" onClick={() => picker.current?.click()}>
              <Paperclip /> Прикрепить файлы
            </Button>
            <ul className="mt-2 space-y-1">
              {files.map((file, index) => (
                <li key={`${file.name}-${index}`} className="flex items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                  <span className="text-muted-foreground">{formatBytes(file.size)}</span>
                  <button
                    type="button"
                    className="text-destructive"
                    onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                  >
                    убрать
                  </button>
                </li>
              ))}
            </ul>
            {progress && <p className="mt-2 text-xs agentiz-attention">{progress}</p>}
          </div>
        </div>
        <SheetFooter>
          <Button disabled={busy} onClick={submit}>Создать</Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Отмена</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/**
 * «Задачи» — the board of one project.
 *
 * Server-rendered once and then reloaded: a task's status moves while a run works on it, which is
 * the whole reason to keep the page open. The tab and the filters live in the address and are
 * applied **on the server** for the same reason the run board applies its status filter there —
 * the page is capped, so a tab filtered in the browser would answer «упавших нет» while the
 * failure sits past the limit.
 */
export function TasksScreen({
  initial,
  projectId,
  slug,
  initialView,
  initialPriority,
  initialSearch,
  priorities,
}: {
  initial: TaskList;
  projectId: string;
  slug: string;
  initialView: string;
  initialPriority: string;
  initialSearch: string;
  priorities: string[];
}) {
  useViewerTimezone();
  const [list, setList] = React.useState<TaskList>(initial);
  const [view, setView] = React.useState(taskView(initialView).key);
  // An address may name a priority that is not in the list (a hand-edited query, a value that has
  // since gone): the select would render blank on it. The list is what it can show.
  const [priority, setPriority] = React.useState(
    PRIORITY_OPTIONS.some((option) => option.value === initialPriority) ? initialPriority : 'all',
  );
  const [search, setSearch] = React.useState(initialSearch);
  const [selectedId, setSelectedId] = React.useState<string | null>(queryParam('task'));
  const [stale, setStale] = React.useState(false);
  const [newOpen, setNewOpen] = React.useState(queryParam('new') === '1');

  const load = React.useCallback(async (
    next: { view: string; priority: string; search: string },
    quiet = false,
  ) => {
    try {
      const response = await axios.get(TASKS_API, {
        params: {
          _method: 'getTasks',
          projectId,
          view: next.view,
          priority: next.priority === 'all' ? undefined : next.priority,
          search: next.search || undefined,
        },
      });
      setList({
        items: response.data?.data ?? [],
        total: response.data?.meta?.total ?? 0,
        statusCounts: response.data?.meta?.statusCounts ?? {},
      });
      setStale(false);
    } catch (error: any) {
      // A failed reload must not empty a list somebody is reading, and must not shout either.
      setStale(true);
      if (!quiet) toast.error(error?.response?.data?.message ?? 'Не удалось загрузить задачи');
    }
  }, [projectId]);

  const reload = React.useCallback((quiet = false) => load({ view, priority, search }, quiet), [load, view, priority, search]);

  // The search is the server's, so it is debounced rather than sent per keystroke. The effect
  // watches the text alone — the tab and the priority load on their own — and reads the other two
  // from a ref, or every tab click would fire a second, identical request.
  const others = React.useRef({ view, priority });
  others.current = { view, priority };
  const firstSearch = React.useRef(true);
  React.useEffect(() => {
    // The first render already carries the value from the address; re-asking for it would be one
    // round trip to arrive at the payload the page was rendered with.
    if (firstSearch.current) {
      firstSearch.current = false;
      return undefined;
    }
    const timer = window.setTimeout((): void => {
      setQueryParam('search', search || null);
      void load({ ...others.current, search });
    }, 350);
    return (): void => { window.clearTimeout(timer); };
  }, [search, load]);

  // Polling, while there is something that can still move by itself.
  const live = list.items.some((task) => LIVE_TASK_STATUSES.includes(task.status));
  React.useEffect(() => {
    if (!live) return undefined;
    const timer = window.setInterval((): void => { void reload(true); }, 5000);
    return (): void => { window.clearInterval(timer); };
  }, [live, reload]);

  const applyView = (value: string) => {
    setView(value);
    setQueryParam('view', value === DEFAULT_TASK_VIEW ? null : value);
    void load({ view: value, priority, search });
  };

  const applyPriority = (value: string) => {
    setPriority(value);
    setQueryParam('priority', value === 'all' ? null : value);
    void load({ view, priority: value, search });
  };

  const select = (taskId: string | null) => {
    setSelectedId(taskId);
    setQueryParam('task', taskId);
  };

  const selected = list.items.find((task) => task.id === selectedId) ?? null;
  const filtered = priority !== 'all' || Boolean(search.trim());

  return (
    <Page width="wide">
      <PageHeader
        title="Задачи"
        meta={[
          <span key="total">{list.total} {plural(list.total, 'задача', 'задачи', 'задач')} под фильтром</span>,
          stale ? <span key="stale" className="agentiz-attention">список не обновляется — сервер не отвечает</span> : null,
        ]}
        actions={<Button onClick={() => setNewOpen(true)}><Plus /> Новая задача</Button>}
        tabs={
          <Tabs value={view} onValueChange={applyView}>
            <TabsList>
              {TASK_VIEWS.map((entry) => (
                <TabsTrigger key={entry.key} value={entry.key}>
                  {entry.label}
                  <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">
                    {taskViewCount(entry, list.statusCounts)}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        }
      />

      <FilterBar>
        <SearchInput value={search} onChange={setSearch} placeholder="Название, описание, внешний id" />
        <Filter value={priority} onChange={applyPriority} options={PRIORITY_OPTIONS} />
        <span className="text-xs text-muted-foreground">
          показано {list.items.length} из {list.total} · поиск и фильтр считает сервер
        </span>
      </FilterBar>

      <div className={cn('grid gap-4', selected && 'xl:grid-cols-[minmax(0,1fr)_440px]')}>
        <div className="min-w-0">
          {list.items.length === 0 ? (
            <EmptyState
              title="Задач под фильтр нет"
              description={filtered ? 'Под этот фильтр ничего не подошло.' : 'Заведите задачу или подключите источник — тогда они появятся здесь.'}
              action={filtered ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setSearch(''); applyPriority('all'); }}
                >
                  Сбросить фильтры
                </Button>
              ) : undefined}
            />
          ) : (
            <ul className="divide-y rounded-lg border">
              {list.items.map((task) => (
                <TaskRowView
                  key={task.id}
                  task={task}
                  selected={selectedId === task.id}
                  onSelect={() => select(selectedId === task.id ? null : task.id)}
                />
              ))}
            </ul>
          )}
        </div>

        {selected && (
          <div className="xl:sticky xl:top-4 xl:self-start">
            <TaskCard key={selected.id} taskId={selected.id} slug={slug} onChanged={() => void reload(true)} />
          </div>
        )}
      </div>

      <NewTaskSheet
        open={newOpen}
        onOpenChange={(open: boolean) => { setNewOpen(open); setQueryParam('new', open ? '1' : null); }}
        projectId={projectId}
        priorities={priorities}
        onCreated={(taskId) => { void reload(); select(taskId); }}
      />
    </Page>
  );
}

// ---------------------------------------------------------------------------------------------
// One task
// ---------------------------------------------------------------------------------------------

function EditTaskSheet({
  open,
  onOpenChange,
  task,
  statuses,
  priorities,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: TaskDetails['task'];
  statuses: string[];
  priorities: string[];
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState({
    title: task.title,
    description: task.description ?? '',
    status: task.status,
    priority: task.priority,
    tags: (task.tags ?? []).join(', '),
  });
  const [busy, setBusy] = React.useState(false);

  const submit = async () => {
    setBusy(true);
    const saved = await post({
      _method: 'updateTask',
      taskId: task.id,
      title: form.title,
      description: form.description,
      status: form.status,
      priority: form.priority,
      tags: parseTags(form.tags),
    }, 'Задача изменена');
    setBusy(false);
    if (saved) {
      onOpenChange(false);
      onSaved();
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Изменить задачу</SheetTitle>
          <SheetDescription>
            Статус, пока задачей владеет запуск, сервер менять откажется — пайплайн всё равно перезапишет правку.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4">
          <label className="block text-sm font-medium">
            Название
            <Input
              className="mt-1.5"
              value={form.title}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, title: event.target.value })}
            />
          </label>
          <label className="block text-sm font-medium">
            Описание
            <Textarea
              className="mt-1.5"
              rows={8}
              value={form.description}
              onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setForm({ ...form, description: event.target.value })}
            />
          </label>
          <label className="block text-sm font-medium">
            Теги
            <Input
              className="mt-1.5"
              value={form.tags}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, tags: event.target.value })}
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium">
              Статус
              <Filter
                className="mt-1.5 w-full"
                value={form.status}
                onChange={(value: string) => setForm({ ...form, status: value })}
                options={statuses.map((value) => ({ value, label: statusLabel(value) }))}
              />
            </label>
            <label className="block text-sm font-medium">
              Приоритет
              <Filter
                className="mt-1.5 w-full"
                value={form.priority}
                onChange={(value: string) => setForm({ ...form, priority: value })}
                options={priorities.map((value) => ({ value, label: PRIORITY_LABELS[value] ?? value }))}
              />
            </label>
          </div>
        </div>
        <SheetFooter>
          <Button disabled={busy} onClick={submit}>Сохранить</Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Отмена</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** The thread. A human comment here is an instruction the next run receives last, not a note. */
function CommentsTab({ details, onChanged }: { details: TaskDetails; onChanged: () => void }) {
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const send = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    const saved = await post({ _method: 'addComment', taskId: details.task.id, body: draft });
    setBusy(false);
    if (saved) {
      setDraft('');
      onChanged();
    }
  };

  return (
    <div className="space-y-4">
      {details.task.canPullComments && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const result = await post({ _method: 'pullComments', taskId: details.task.id });
              setBusy(false);
              if (result) {
                toast.success(`Из трекера: ${result.fetched}, новых ${result.created}, обновлено ${result.updated}`);
                onChanged();
              }
            }}
          >
            Подтянуть из трекера
          </Button>
        </div>
      )}

      {details.comments.length === 0 && <EmptyState title="Обсуждения ещё нет" />}

      {details.comments.map((comment) => {
        const fromTracker = comment.origin === 'remote';
        const publishable = comment.authorKind !== 'system' && !fromTracker && !comment.externalUrl && details.task.externalUrl;
        return (
          <div key={comment.id} className="rounded-lg border p-3">
            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium">{comment.authorName ?? AUTHOR_LABELS[comment.authorKind]}</span>
              <Badge variant="outline" className="h-4 px-1 text-[10px]">{AUTHOR_LABELS[comment.authorKind]}</Badge>
              {/* Who wrote it and where it was written are different facts. */}
              {fromTracker && <Badge variant="outline" className="h-4 px-1 text-[10px]">из трекера</Badge>}
              <span className="text-muted-foreground">{formatDateTime(comment.externalCreatedAt ?? comment.createdAt)}</span>
              {comment.externalUrl && (
                <a href={comment.externalUrl} target="_blank" rel="noreferrer" className="underline">
                  {fromTracker ? 'открыть в трекере' : 'опубликован в трекере'}
                </a>
              )}
            </div>
            <p className="whitespace-pre-wrap text-sm">{comment.body}</p>
            {publishable && (
              <button
                type="button"
                className="mt-1 text-xs underline"
                onClick={async () => {
                  if (await post({ _method: 'publishComment', commentId: comment.id }, 'Отправлено в трекер')) onChanged();
                }}
              >
                отправить в трекер
              </button>
            )}
          </div>
        );
      })}

      <div className="rounded-lg border p-3">
        <Textarea
          rows={3}
          value={draft}
          onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value)}
          placeholder="Комментарий. Он станет текущей инструкцией для следующего запуска."
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            Запуск, начатый из комментария, получает всю переписку, а сам комментарий — последним.
          </span>
          <Button size="sm" disabled={busy || !draft.trim()} onClick={send}>Отправить</Button>
        </div>
      </div>
    </div>
  );
}

/** The task's runs. The log, the diff and the review live on the run's own screen, not here. */
function RunsTab({ details, slug, onChanged }: { details: TaskDetails; slug: string; onChanged: () => void }) {
  const [busy, setBusy] = React.useState<string | null>(null);
  if (details.runs.length === 0) {
    return <EmptyState title="Запусков не было" description="Нажмите «Запустить» — запуск появится здесь." />;
  }
  return (
    <ul className="divide-y rounded-lg border">
      {details.runs.map((run) => {
        const live = !TERMINAL_RUN_STATUSES.includes(run.status);
        const cancelled = run.status === 'cancelled';
        return (
          <li key={run.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
            <a href={href('project.run', { slug, runId: run.id })} className="w-20 shrink-0 font-mono text-xs hover:underline">
              {shortId(run.id)}
            </a>
            <StatusBadge status={run.status} className="w-32 shrink-0 justify-center" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-muted-foreground">
                {[
                  triggerLabel(run.trigger),
                  formatDateTime(run.createdAt),
                  run.branch ?? null,
                  Number(run.usageTotalTokens) > 0 ? `${formatTokens(Number(run.usageTotalTokens))} ткн` : null,
                ].filter(Boolean).join(' · ')}
              </p>
              {run.errorMessage && (
                // A cancellation writes its reason into the same column as a failure; printing
                // «Cancelled by user» in red says something went wrong, and nothing did.
                <p className={cn('truncate text-xs', cancelled ? 'text-muted-foreground' : 'text-destructive')}>
                  {run.errorMessage}
                </p>
              )}
            </div>
            {run.verdict && <StatusBadge status={run.verdict} className="shrink-0" />}
            {live && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy === run.id}
                onClick={async () => {
                  setBusy(run.id);
                  const stopped = await post({ _method: 'cancelRun', runId: run.id }, 'Запуск остановлен');
                  setBusy(null);
                  if (stopped) onChanged();
                }}
              >
                Остановить
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The files attached to the task.
 *
 * They travel to a run as metadata: the worker downloads the bytes itself and lays them out
 * **beside** the working tree, so they never land in the run's diff. A file added after a run
 * started belongs to the next one.
 */
function FilesTab({ details, onChanged }: { details: TaskDetails; onChanged: () => void }) {
  const [progress, setProgress] = React.useState<string | null>(null);
  const [dragOver, setDragOver] = React.useState(false);
  const [preview, setPreview] = React.useState<TaskAttachment | null>(null);
  const picker = React.useRef<HTMLInputElement | null>(null);

  // Re-read either way: the loop stops at the first failure, so the files before it are already
  // attached and the list would otherwise not show them.
  const upload = async (files: File[] | FileList) => {
    await uploadFiles(details.task.id, files, setProgress);
    onChanged();
  };

  return (
    <div className="space-y-4">
      <div
        onDragOver={(event: React.DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event: React.DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          setDragOver(false);
          if (event.dataTransfer?.files?.length) void upload(event.dataTransfer.files);
        }}
        className={cn('rounded-lg border border-dashed p-4', dragOver && 'border-primary bg-accent/40')}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            Перетащите файлы сюда или выберите кнопкой — агент получит их отдельной папкой рядом с рабочим деревом.
          </p>
          <input
            ref={picker}
            type="file"
            multiple
            className="sr-only"
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
              if (event.target.files?.length) void upload(event.target.files);
              event.target.value = '';
            }}
          />
          <Button variant="outline" size="sm" disabled={progress !== null} onClick={() => picker.current?.click()}>
            <Paperclip /> Прикрепить
          </Button>
        </div>
        {progress && <p className="mt-2 text-xs agentiz-attention">{progress}</p>}
      </div>

      {details.attachments.length === 0 ? (
        <EmptyState title="Файлов нет" />
      ) : (
        <ul className="divide-y rounded-lg border">
          {details.attachments.map((attachment) => (
            <li key={attachment.id} className="flex items-center gap-3 px-4 py-2.5">
              {isImage(attachment) ? (
                <button type="button" onClick={() => setPreview(attachment)} title="Показать">
                  <img
                    src={attachmentUrl(attachment.id, true)}
                    alt={attachment.fileName}
                    className="size-10 rounded border object-cover"
                  />
                </button>
              ) : (
                <Paperclip className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{attachment.fileName}</span>
                <span className="block text-xs text-muted-foreground">
                  {[formatBytes(attachment.sizeBytes), attachment.uploadedByName, formatDateTime(attachment.createdAt)]
                    .filter(Boolean).join(' · ')}
                </span>
              </span>
              <Button asChild variant="outline" size="sm"><a href={attachmentUrl(attachment.id)}>Скачать</a></Button>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  if (!window.confirm(`Удалить файл «${attachment.fileName}»?`)) return;
                  if (await post({ _method: 'deleteAttachment', attachmentId: attachment.id }, 'Файл удалён')) onChanged();
                }}
              >
                Удалить
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={preview !== null} onOpenChange={(open: boolean) => { if (!open) setPreview(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle className="truncate">{preview?.fileName}</DialogTitle></DialogHeader>
          {preview && (
            <img src={attachmentUrl(preview.id, true)} alt={preview.fileName} className="max-h-[70vh] w-full object-contain" />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * «Задача» — one task in full.
 *
 * The tabs are query parameters and change nothing on the server; the address of the task itself is
 * a page load, because the sidebar and the crumbs are per-request props.
 */
export function TaskScreen({
  taskId,
  slug,
  found,
  statuses,
  priorities,
}: {
  taskId: string;
  slug: string;
  found: boolean;
  statuses: string[];
  priorities: string[];
}) {
  useViewerTimezone();
  const { details, failed, reload } = useTaskDetails(found ? taskId : null);
  const [tab, setTab] = React.useState(queryParam('tab') ?? 'overview');
  const [editOpen, setEditOpen] = React.useState(false);
  const [runOpen, setRunOpen] = React.useState(false);

  const task = details?.task ?? null;
  const live = Boolean(task && LIVE_TASK_STATUSES.includes(task.status));

  // Polling, while the task can still move by itself — a run writes its status and its thread.
  React.useEffect(() => {
    if (!live) return undefined;
    const timer = window.setInterval((): void => { void reload({ quiet: true }); }, 5000);
    return (): void => { window.clearInterval(timer); };
  }, [live, reload]);

  const selectTab = (value: string) => {
    setTab(value);
    setQueryParam('tab', value === 'overview' ? null : value);
  };

  if (!found) {
    return (
      <Page>
        <PageHeader title="Задача" meta={<span className="font-mono">{shortId(taskId)}</span>} />
        <EmptyState
          title="Задача не найдена"
          description="Она либо удалена, либо принадлежит другому проекту."
          action={<Button asChild variant="outline"><a href={href('project.tasks', { slug })}>Все задачи проекта</a></Button>}
        />
      </Page>
    );
  }

  if (!details || !task) {
    return (
      <Page>
        <PageHeader title="Задача" meta={<span className="font-mono">{shortId(taskId)}</span>} />
        {failed
          ? <EmptyState title="Не удалось загрузить задачу" description="Обновите страницу." />
          : <p className="text-sm text-muted-foreground">Загрузка…</p>}
      </Page>
    );
  }

  const waiting = details.actionRequired ?? [];
  const decidedApprovals = (details.workflow?.approvals ?? []).filter((approval) => approval.status !== 'pending');

  return (
    <Page>
      <PageHeader
        title={<><span className="font-mono text-muted-foreground">{taskNumber(task)}</span> {task.title}</>}
        meta={[
          <StatusBadge key="status" status={task.status} />,
          task.workflowStatus ? <span key="flow">{task.workflowStatus}</span> : null,
          <span key="priority">{PRIORITY_LABELS[task.priority] ?? task.priority} приоритет</span>,
          <span key="source">
            {details.task.sourceName ?? details.task.sourceTitle ?? 'вручную'}
            {task.sourceType && task.sourceType !== 'local' ? ` · ${task.remoteExternalId ?? task.externalId}` : ''}
          </span>,
          task.externalUrl ? (
            <a key="link" href={task.externalUrl} target="_blank" rel="noreferrer" className="underline">открыть в трекере</a>
          ) : null,
          failed ? <span key="stale" className="agentiz-attention">не обновляется — сервер не отвечает</span> : null,
        ]}
        actions={
          <>
            <Button variant="outline" onClick={() => setEditOpen(true)}>Изменить</Button>
            <Button onClick={() => setRunOpen(true)}><Play /> Запустить</Button>
          </>
        }
        tabs={
          <Tabs value={tab} onValueChange={selectTab}>
            <TabsList>
              <TabsTrigger value="overview">Обзор</TabsTrigger>
              <TabsTrigger value="comments">
                Обсуждение <span className="ml-1.5 text-xs text-muted-foreground">{details.comments.length}</span>
              </TabsTrigger>
              <TabsTrigger value="runs">
                Запуски <span className="ml-1.5 text-xs text-muted-foreground">{details.runs.length}</span>
              </TabsTrigger>
              <TabsTrigger value="files">
                Файлы <span className="ml-1.5 text-xs text-muted-foreground">{details.attachments.length}</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />

      <AttentionStrip items={waiting} onDone={() => void reload()} />

      {!details.runOptions && (
        <div className="mb-6 rounded-lg border border-warning/50 bg-warning/10 p-4 text-sm">
          <div className="mb-1 flex items-center gap-2 font-medium">
            <AlertTriangle className="size-4 agentiz-attention" /> Запускать нечего
          </div>
          <p className="text-muted-foreground">
            У проекта нет активного пайплайна, который подошёл бы этой задаче. Заведите его в разделе «Пайплайны» —
            всё остальное на этом экране работает и без него.
          </p>
        </div>
      )}

      {tab === 'overview' && (
        <div className="space-y-6">
          <div>
            <h2 className="mb-2 text-sm font-semibold">Описание</h2>
            <p className="whitespace-pre-line text-sm text-muted-foreground">{task.description || 'Без описания.'}</p>
          </div>

          <Separator />

          <Facts
            items={[
              ['Пайплайн', details.runOptions?.pipeline?.name ?? '—'],
              ['Источник', details.source?.name ?? details.task.sourceTitle ?? 'вручную'],
              ['Теги', (task.tags ?? []).join(', ') || '—'],
              ['Статус в трекере', task.externalStatus || '—'],
              ['Создана', formatDateTime(task.createdAt) || '—'],
              ['Обновлена', formatDateTime(task.updatedAt) || '—'],
              ['Внешний id', task.externalId],
            ]}
          />

          {details.workflow && (details.workflow.status || details.workflow.rounds > 0) && (
            <div>
              <h2 className="mb-2 text-sm font-semibold">Воркфлоу</h2>
              <div className="rounded-lg border bg-muted/30 p-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{details.workflow.status ?? 'без статуса'}</span>
                  <span className="text-xs text-muted-foreground">
                    {details.workflow.rounds} {plural(details.workflow.rounds, 'круг', 'круга', 'кругов')}
                    {details.workflow.currentRunId ? ' · идёт сейчас' : ' · сейчас не идёт'}
                  </span>
                </div>
                {/* Decided approvals only: the pending ones are in «требует внимания» above, with
                    their buttons, and printing them twice gives two places to press. */}
                {decidedApprovals.slice(0, 5).map((approval) => (
                  <p key={approval.id} className="mt-1.5 text-xs text-muted-foreground">
                    {approval.title} — {approval.status === 'approved' ? 'принято' : approval.status === 'rejected' ? 'отклонено' : approval.status}
                    {approval.decisionComment ? `: ${approval.decisionComment}` : ''}
                  </p>
                ))}
              </div>
            </div>
          )}

          {details.runs.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-semibold">Последний запуск</h2>
              <RunsTab details={{ ...details, runs: details.runs.slice(0, 1) }} slug={slug} onChanged={() => void reload()} />
            </div>
          )}
        </div>
      )}

      {tab === 'comments' && <CommentsTab details={details} onChanged={() => void reload()} />}
      {tab === 'runs' && <RunsTab details={details} slug={slug} onChanged={() => void reload()} />}
      {tab === 'files' && <FilesTab details={details} onChanged={() => void reload()} />}

      {/* Both forms are mounted only while open: the poll below rewrites `details` every five
          seconds, and a form seeded once from the first render would drift from what it is
          editing without ever saying so. */}
      {editOpen && (
        <EditTaskSheet
          open
          onOpenChange={setEditOpen}
          task={task}
          statuses={statuses}
          priorities={priorities}
          onSaved={() => void reload()}
        />
      )}
      {runOpen && (
        <RunDialog
          open
          onOpenChange={setRunOpen}
          details={details}
          onLaunched={(runId) => {
            if (runId) window.location.href = href('project.run', { slug, runId });
            else void reload();
          }}
        />
      )}
    </Page>
  );
}
