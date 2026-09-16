import * as React from 'react';
import { Plus } from 'lucide-react';
import { router } from '@inertiajs/react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { href } from '../../../lib/panel/routeTree';
import {
  DEFAULT_HOOK_TIMEOUT_SEC,
  HOOK_VARIABLES,
  unknownHookVariables,
  type HookVariableScope,
} from '../../../lib/hookEnv';
import {
  addStage,
  moveStage,
  pipelineDraft,
  removeStage,
  sameDocument,
  sourceKindOf,
  withFinalAction,
  withHook,
  withHumanCommentTrigger,
  withRepositorySource,
  withStage,
  withStageRuntime,
  withStashDirty,
  withWorkspaceDelivery,
  withWorkspaceRepository,
  withWorkspaceSource,
  type PipelineDoc,
  type PipelineHookDoc,
  type PipelineSourceKind,
  type HookPosition,
} from '../../../lib/pipelineDraft';
import { resolveWorkspaceGitGrant } from '../../../lib/workspaceGit';
import { workspaceOwnerProjectId } from '../../../lib/workspaceOwnership';
import type {
  PanelPipelineBoard,
  PanelPipelineRow,
  PanelPipelineWorker,
} from '../../../lib/panel/pipelinesPanel';
import { Filter, FilterBar, SearchInput } from './blocks';
import { ago, plural, queryParam, setQueryParam } from './format';
import { EmptyState, Facts, PageHeader, Section } from './page';
import { NotificationScopePanel } from './settings';
import { StatusBadge } from './status';
import { cn, toast } from './ui';
import { formatDateTime, useViewerTimezone } from './viewerTime';

/**
 * The two pipeline screens: the pipelines of a project, and one spec in full.
 *
 * One file because they are one subject at two levels of detail — the row has to say what a
 * pipeline works on, which is exactly what the «Источник» tab edits, and a row and a form wording
 * the same fact differently is how an operator stops trusting either.
 *
 * **The one behaviour this port changes** is when a spec is written. The previous editor saved the
 * whole document on every touched field: picking a worker, ticking a checkbox and typing a path
 * were three saves and three validation round trips, and closing the tab mid-thought had already
 * stored whatever was half-done. Here the draft is local and «Сохранить» is a press. What that
 * costs is a habit: leaving the page used to be safe by definition. So leaving with unsaved
 * changes asks — on a real navigation (`beforeunload`) and on an Inertia visit
 * (`router.on('before')`), because the sidebar's own links are the second kind and never raise the
 * first.
 *
 * What the draft is, and why it matters more than the buttons: the **stored document itself**,
 * patched. Every edit goes through `lib/pipelineDraft.ts`, which spreads what is there instead of
 * rebuilding it from the fields this screen knows — so `constraints`, `source.branch`,
 * `finalAction.pullRequestTitleTemplate` and whatever lands next survive an editor that has never
 * heard of them. That property is the subject of
 * `services/pipelineEditorBackwardCompat.test.ts`, not of a comment.
 *
 * Not here, deliberately: moving a spec to another project. `PipelineSpec.projectId` is refused on
 * update by the model itself, and offering a control the server rejects is the worst lie a form
 * can tell.
 */

const PREFIX: string = (window as any).routePrefix ?? '/dashboard';
const PIPELINES_API = `${PREFIX}/agentiz-pipelines`;
const axios = (window as any).axios;

/**
 * The panel's own Monaco, reached the way every other panel component is.
 *
 * It replaces the CodeMirror the previous hook editor bundled — ~160 kB of the 618 kB
 * `AgentizPipelines.js`, loaded for everyone who opened the screen and not only for the few who
 * write a hook. The panel already ships an editor and lazy-loads it on first use; a module
 * bundling a second one pays for it on every page.
 *
 * The trade it makes is named on the screen: this component takes `value`/`onChange`/`language`
 * and nothing else, so the variable catalogue cannot be a completion popup any more. It is a
 * palette and a lint line beside the editor instead — both still read `lib/hookEnv.ts`, which is
 * the part that matters: the names offered here are the names a run will actually export.
 */
const MonacoEditor: React.ComponentType<{
  value: string;
  onChange: (value: string) => void;
  options: { language: string };
  disabled?: boolean;
}> | null = (window as any).JSComponents?.MonacoEditor ?? null;

/**
 * Radix refuses an item whose value is the empty string, so «ничего не выбрано» needs a sentinel —
 * the same trick the fleet screen uses for «нет подписки». It never leaves this file: `pick`
 * translates it back to `undefined`, which is what the document stores.
 */
const NONE = '__none__';

function withNone(label: string, options: Array<{ value: string; label: string }>) {
  return [{ value: NONE, label }, ...options];
}

function pick(value: string): string | undefined {
  return value === NONE ? undefined : value;
}

// ---------------------------------------------------------------------------------------------
// Reading a pipeline: what a row says, in the words both screens use
// ---------------------------------------------------------------------------------------------

const FINAL_ACTION_LABELS: Record<string, string> = {
  commit_and_pr: 'Коммит и pull request',
  commit: 'Коммит и push',
  comment_only: 'Только результат в задаче',
  none: 'Ничего',
};

/** The directory a `worker_workspace` pipeline runs in, resolved the way the queue resolves it. */
function workspaceDirectory(worker: PanelPipelineWorker | undefined, row: PanelPipelineRow['workspace']): string {
  if (!row) return '';
  const declared = (worker?.workspaces ?? []).find((item) => item.key === row.workspaceKey);
  return declared?.path ?? row.path ?? '';
}

/**
 * Whether this directory may push, and to which remote.
 *
 * Imported from `lib/workspaceGit.ts` rather than mirrored here: that module is the server's own
 * answer and carries no runtime import, so the editor greys out exactly what a run would refuse.
 * The grant is the **worker's**, never the spec's — a pipeline can only name a directory the
 * machine's operator already opened.
 */
function pushGrant(worker: PanelPipelineWorker | undefined, directory: string) {
  const declared = (worker?.workspaces ?? []).find((item) => item.path === directory || item.key === directory);
  return resolveWorkspaceGitGrant(directory, worker?.gitPushRoots ?? [], declared);
}

/** One line under the pipeline's name: what it works on, in the vocabulary of the source tab. */
function sourceLine(row: PanelPipelineRow, board: PanelPipelineBoard): string {
  if (row.sourceKind === 'worker_workspace') {
    const worker = board.workers.find((item) => item.id === row.workspace?.workerId);
    const directory = workspaceDirectory(worker, row.workspace);
    const grant = pushGrant(worker, directory);
    const parts = ['Папка воркера', worker?.name ?? row.workspace?.workerId ?? '—', directory || 'папка не выбрана'];
    if (row.finalAction === 'commit') parts.push(grant ? `коммит и push в ${grant.remote}` : 'push не разрешён воркером');
    return parts.filter(Boolean).join(' · ');
  }
  const repository = board.repositories.find((item) => item.repositoryId === row.repositoryId);
  return [
    'Репозиторий',
    repository?.pathWithNamespace ?? (row.repositoryId ? row.repositoryId : 'репозиторий задачи'),
    repository?.defaultBranch ? `база ${repository.defaultBranch}` : null,
  ].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------------

const LIST_FILTERS = [
  { value: 'all', label: 'Все' },
  { value: 'active', label: 'Активные' },
  { value: 'draft', label: 'Черновики' },
];

export function PipelinesScreen({ initial, slug }: { initial: PanelPipelineBoard; slug: string }) {
  useViewerTimezone();
  // Read-only: nothing on this screen writes, so there is nothing to reload and no poll. Every
  // number here changes only when a run finishes, and a run screen is one click away.
  const state = initial;
  const [filter, setFilter] = React.useState('all');
  const [search, setSearch] = React.useState('');

  const needle = search.trim().toLowerCase();
  const rows = state.specs
    .filter((row) => (filter === 'all' ? true : filter === 'active' ? row.isActive : !row.isActive))
    .filter((row) => !needle || [row.name, ...(row.matchTags ?? [])].some((value) => (value ?? '').toLowerCase().includes(needle)));
  const active = state.specs.filter((row) => row.isActive).length;

  return (
    <>
      <PageHeader
        title="Пайплайны"
        meta={[
          <span key="count">{state.specs.length} {plural(state.specs.length, 'пайплайн', 'пайплайна', 'пайплайнов')}</span>,
          state.specs.length > 0 ? <span key="active">{active} активных</span> : null,
        ]}
        description="Пайплайн — что и в каком порядке делают агенты над задачей. Когда его запускать, решает воркфлоу или ручной запуск."
        // Создание спеки живёт в форме CRUD — здесь только адрес на неё, чтобы «завести пайплайн»
        // не приходилось искать в «Моделях данных». Настраивают спеку уже на её экране.
        actions={state.canConfigure ? (
          <Button asChild>
            <a href={`${PREFIX}/model/PipelineSpec/add`}><Plus /> Новый пайплайн</a>
          </Button>
        ) : undefined}
      />

      {state.specs.length > 3 && (
        <FilterBar>
          <Filter value={filter} onChange={setFilter} options={LIST_FILTERS} />
          <SearchInput value={search} onChange={setSearch} placeholder="Название или тег" />
        </FilterBar>
      )}

      {state.specs.length === 0 ? (
        <EmptyState
          title="Пайплайнов нет"
          description="Спека пайплайна — JSON-документ: стадии, источник работы и что сделать с результатом. Заводят её ассистент панели, MCP-инструмент agentiz.manage или форма в разделе «Модели данных»; настраивают — здесь."
          action={<Button asChild variant="outline"><a href={`${PREFIX}/model/PipelineSpec`}>Открыть таблицу PipelineSpec</a></Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState title="Ничего не найдено" description="Ни один пайплайн не подходит под фильтр." />
      ) : (
        <ul className="divide-y rounded-lg border">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <a href={href('project.pipeline', { slug, specId: row.id })} className="truncate text-sm font-medium hover:underline">
                    {row.name}
                  </a>
                  {row.isDefault && <Badge variant="outline">по умолчанию</Badge>}
                  {row.matchTags?.length ? <Badge variant="outline">теги: {row.matchTags.join(', ')}</Badge> : null}
                  {row.notify?.mute && <Badge variant="outline">уведомления замьючены</Badge>}
                  {row.notify && !row.notify.mute && <Badge variant="outline">свои уведомления</Badge>}
                </div>
                <p className="truncate text-xs text-muted-foreground">{sourceLine(row, state)}</p>
              </div>
              <span className="w-24 shrink-0 text-right text-xs text-muted-foreground tabular-nums max-md:hidden">
                {row.stageCount} {plural(row.stageCount, 'этап', 'этапа', 'этапов')}
              </span>
              <span className="w-28 shrink-0 text-right text-xs text-muted-foreground tabular-nums max-lg:hidden">
                {row.runCount} {plural(row.runCount, 'запуск', 'запуска', 'запусков')}
              </span>
              <StatusBadge status={row.isActive ? 'active' : 'draft'} className="w-28 shrink-0 justify-center" />
            </li>
          ))}
        </ul>
      )}

      <Separator className="my-6" />
      <Facts
        items={[
          ['Какой пайплайн возьмёт задачу', 'первый, чьи теги совпали; иначе помеченный «по умолчанию»'],
          ['Выключенный пайплайн', 'не подбирается по тегам и не запускается вручную'],
          ['Воркфлоу', <a key="wf" href={href('project.workflows', { slug })} className="hover:underline">графы этого проекта</a>],
        ]}
      />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// One spec
// ---------------------------------------------------------------------------------------------

const TABS = [
  { value: 'overview', label: 'Обзор' },
  { value: 'agents', label: 'Агенты' },
  { value: 'stages', label: 'Этапы' },
  { value: 'source', label: 'Источник' },
  { value: 'hooks', label: 'Хуки' },
  { value: 'notifications', label: 'Уведомления' },
];

/** The row's own columns, edited beside the document and saved in the same press. */
interface RowDraft {
  name: string;
  matchTags: string;
  isActive: boolean;
}

function rowDraftOf(row: PanelPipelineRow): RowDraft {
  return { name: row.name, matchTags: (row.matchTags ?? []).join(', '), isActive: row.isActive };
}

export function PipelineScreen({
  initial,
  slug,
  projectId,
  specId,
}: {
  initial: PanelPipelineBoard;
  slug: string;
  projectId: string;
  specId: string;
}) {
  useViewerTimezone();
  const opened = initial.spec;
  const [tab, setTab] = React.useState(queryParam('tab') ?? 'overview');
  const [saved, setSaved] = React.useState<PipelineDoc | null>(opened ? pipelineDraft(opened.spec) : null);
  const [draft, setDraft] = React.useState<PipelineDoc | null>(opened ? pipelineDraft(opened.spec) : null);
  const [savedRow, setSavedRow] = React.useState<RowDraft | null>(opened ? rowDraftOf(opened) : null);
  const [row, setRow] = React.useState<RowDraft | null>(opened ? rowDraftOf(opened) : null);
  const [roles, setRoles] = React.useState(initial.roles);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // The one header fact a save moves. Kept in state rather than read from the first paint, or the
  // line would keep saying «изменён вчера» right after somebody pressed «Сохранить».
  const [updatedAt, setUpdatedAt] = React.useState<string | null>(opened?.updatedAt ?? null);

  const dirty = Boolean(draft && saved && (!sameDocument(draft, saved) || !sameDocument(row, savedRow)));

  /**
   * Leaving with unsaved changes asks first, and it has to ask twice over, because the two ways
   * out of this page are different events: a real navigation (the address bar, a plain link, the
   * tab closing) raises `beforeunload`, while the panel's own sidebar is an Inertia visit, which
   * never does. Missing the second is what would make «закрыл вкладку — потерял» true again for
   * exactly the click a person makes most often.
   */
  const dirtyRef = React.useRef(dirty);
  dirtyRef.current = dirty;
  React.useEffect(() => {
    const onUnload = (event: BeforeUnloadEvent): void => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    const off = router.on('before', () => {
      if (!dirtyRef.current) return true;
      return window.confirm('В пайплайне есть несохранённые изменения. Уйти и потерять их?');
    });
    return (): void => {
      window.removeEventListener('beforeunload', onUnload);
      off();
    };
  }, []);

  const selectTab = (value: string) => {
    setTab(value);
    setQueryParam('tab', value === 'overview' ? null : value);
  };

  const patch = React.useCallback((next: (current: PipelineDoc) => PipelineDoc) => {
    setDraft((current) => (current ? next(current) : current));
  }, []);

  const save = React.useCallback(async () => {
    if (!draft || !row) return;
    setBusy(true);
    setError(null);
    try {
      const response = await axios.post(PIPELINES_API, {
        _method: 'updatePipelineSpec',
        specId,
        spec: draft,
        name: row.name,
        isActive: row.isActive,
        matchTags: row.matchTags.split(',').map((tag) => tag.trim()).filter(Boolean),
      });
      const stored = response.data?.data ?? {};
      // Adopt what was stored, not what was sent: the model normalises on the way in (an empty tag
      // list becomes null), and a draft that keeps claiming unsaved changes after a successful
      // save is indistinguishable from one that failed.
      const document = pipelineDraft((stored.spec ?? draft) as PipelineDoc);
      setSaved(document);
      setDraft(document);
      const nextRow: RowDraft = {
        name: String(stored.name ?? row.name),
        matchTags: (stored.matchTags ?? []).join(', '),
        isActive: stored.isActive !== false,
      };
      setSavedRow(nextRow);
      setRow(nextRow);
      if (typeof stored.updatedAt === 'string') setUpdatedAt(stored.updatedAt);
      toast.success('Пайплайн сохранён');
    } catch (failure: any) {
      // Kept on the page, not only in a toast: a rejection lists the failing fields and the MCP
      // tool that documents the shape, and that text does not fit in a toast anybody can read.
      setError(failure?.response?.data?.message ?? 'Не удалось сохранить пайплайн');
    } finally {
      setBusy(false);
    }
  }, [draft, row, specId]);

  const setRoleProvider = React.useCallback(async (roleId: string, provider: string) => {
    setBusy(true);
    try {
      const response = await axios.post(PIPELINES_API, { _method: 'setRoleAcpProvider', roleId, provider });
      const stored = response.data?.data ?? {};
      setRoles((current) => current.map((role) => (
        role.id === roleId ? { ...role, provider: stored.config?.provider ?? provider } : role
      )));
      toast.success('ACP-агент роли сохранён');
    } catch (failure: any) {
      toast.error(failure?.response?.data?.message ?? 'Не удалось настроить ACP-агента');
    } finally {
      setBusy(false);
    }
  }, []);

  if (!opened || !draft || !row || !saved || !savedRow) {
    return (
      <>
        <PageHeader title="Пайплайн" />
        <EmptyState
          title="Пайплайн не найден"
          description="Спека удалена, или адрес называет пайплайн другого проекта — спека принадлежит своему проекту и не переезжает."
          action={<Button asChild variant="outline"><a href={href('project.pipelines', { slug })}>Все пайплайны</a></Button>}
        />
      </>
    );
  }

  const readOnly = !initial.canConfigure;
  const kind = sourceKindOf(draft);

  return (
    <>
      <PageHeader
        title={row.name || opened.name}
        meta={[
          <StatusBadge key="status" status={row.isActive ? 'active' : 'draft'} />,
          opened.isDefault ? <span key="default">по умолчанию</span> : null,
          <span key="version">версия {opened.version}</span>,
          updatedAt ? <span key="updated">изменён {formatDateTime(updatedAt)}</span> : null,
          opened.runCount > 0
            ? <span key="runs">{opened.runCount} {plural(opened.runCount, 'запуск', 'запуска', 'запусков')}</span>
            : null,
        ]}
        tabs={
          <Tabs value={tab} onValueChange={selectTab}>
            <TabsList>
              {TABS.map((entry) => (
                <TabsTrigger key={entry.value} value={entry.value}>{entry.label}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        }
      />

      {readOnly ? (
        <p className="mb-4 rounded-lg border px-4 py-2.5 text-sm text-muted-foreground">
          Только чтение: менять пайплайны проекта может участник с ролью настройщика.
        </p>
      ) : (
        <SaveBar dirty={dirty} busy={busy} onSave={() => { void save(); }} onReset={() => { setDraft(saved); setRow(savedRow); setError(null); }} />
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="font-medium">Спека не сохранена</p>
          <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{error}</p>
        </div>
      )}

      {tab === 'overview' && (
        <div className="space-y-6">
          <Section title="Название" description="Видно в списке пайплайнов, в карточке запуска и в уведомлениях.">
            <Input
              value={row.name}
              disabled={readOnly}
              className="max-w-lg"
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setRow({ ...row, name: event.target.value })}
            />
          </Section>
          <Section
            title="Когда применяется"
            description="Теги задачи, при которых берётся этот пайплайн. Пусто — не подбирается по тегам вовсе; такой пайплайн достаётся задаче, только если помечен «по умолчанию» или назван при ручном запуске."
          >
            <Input
              value={row.matchTags}
              placeholder="через запятую"
              disabled={readOnly}
              className="max-w-lg"
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setRow({ ...row, matchTags: event.target.value })}
            />
          </Section>
          <Section title="Активность" description="Выключенный пайплайн не подбирается по тегам и не запускается вручную. Уже идущие запуски не трогает.">
            <label className="flex items-center gap-3 text-sm">
              <Switch checked={row.isActive} disabled={readOnly} onCheckedChange={(value: boolean) => setRow({ ...row, isActive: value })} />
              <span className="text-muted-foreground">{row.isActive ? 'Активен' : 'Черновик'}</span>
            </label>
          </Section>
          <Section title="Запуск по комментарию" description="Сообщение человека в задаче становится основным промптом запуска; весь тред и результаты прошлых запусков едут контекстом.">
            <label className="flex items-center gap-3 text-sm">
              <Switch
                checked={draft.triggers?.humanComment === true}
                disabled={readOnly}
                onCheckedChange={(value: boolean) => patch((current) => withHumanCommentTrigger(current, value))}
              />
              <span className="text-muted-foreground">
                {draft.triggers?.humanComment === true ? 'Запускается после комментария' : 'Только вручную и по воркфлоу'}
              </span>
            </label>
          </Section>

          <Separator />
          <Facts
            items={[
              ['Проект', 'спека принадлежит своему проекту и не переезжает'],
              ['Этапов', String((draft.stages ?? []).length)],
              ['После стадий', FINAL_ACTION_LABELS[String(draft.finalAction?.type)] ?? String(draft.finalAction?.type ?? '—')],
              ['Источник', kind === 'worker_workspace' ? 'папка воркера' : 'репозиторий'],
              ['Хуки', [draft.hooks?.before ? 'before' : null, draft.hooks?.after ? 'after' : null].filter(Boolean).join(', ') || 'нет'],
              ['Последний запуск', opened.lastRunAt ? `${ago(opened.lastRunAt)} назад` : 'не запускался'],
            ]}
          />
        </div>
      )}

      {tab === 'agents' && (
        <AgentsTab roles={roles} readOnly={readOnly} busy={busy} onPick={setRoleProvider} />
      )}

      {tab === 'stages' && (
        <StagesTab doc={draft} roles={roles} readOnly={readOnly} sourceKind={kind} onPatch={patch} />
      )}

      {tab === 'source' && (
        <SourceTab doc={draft} board={initial} projectId={projectId} slug={slug} readOnly={readOnly} onPatch={patch} />
      )}

      {tab === 'hooks' && (
        <HooksTab doc={draft} readOnly={readOnly} sourceKind={kind} onPatch={patch} />
      )}

      {tab === 'notifications' && (
        <NotificationScopePanel scope="pipeline" id={specId} canEdit={!readOnly} inheritsFrom="из проекта" />
      )}
    </>
  );
}

/**
 * «Есть несохранённые изменения · Отменить · Сохранить».
 *
 * Always on the page, not only when something changed: a bar that appears is a bar somebody has to
 * notice, and the point of it is that the state of the document is readable at a glance from any
 * tab — the edit that is unsaved may well be on the tab that is not open.
 */
function SaveBar({
  dirty,
  busy,
  onSave,
  onReset,
}: {
  dirty: boolean;
  busy: boolean;
  onSave: () => void;
  onReset: () => void;
}) {
  const tone = dirty ? 'border-warning/50 bg-warning/10' : 'text-muted-foreground';
  return (
    <div className={cn('mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-sm', tone)}>
      <span>{dirty ? 'Есть несохранённые изменения' : 'Сохранено'}</span>
      {dirty && (
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onReset}>Отменить</Button>
          <Button size="sm" disabled={busy} onClick={onSave}>Сохранить</Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Агенты
// ---------------------------------------------------------------------------------------------

const PROVIDERS = [
  { value: 'codex', label: 'Codex · подписка ChatGPT' },
  { value: 'claude', label: 'Claude · подписка' },
];

/**
 * The project's agent roles and which ACP agent each runs under.
 *
 * A role is **not** part of the spec — it is a row of its own, shared by every pipeline of the
 * project — so it saves on the press and not with «Сохранить» above: the bar speaks for the
 * document, and making it also speak for four other entities is how a save button starts meaning
 * «сохранить что-то».
 */
function AgentsTab({
  roles,
  readOnly,
  busy,
  onPick,
}: {
  roles: PanelPipelineBoard['roles'];
  readOnly: boolean;
  busy: boolean;
  onPick: (roleId: string, provider: string) => void;
}) {
  if (roles.length === 0) {
    return (
      <EmptyState
        title="Ролей в проекте нет"
        description="Стадия называет роль, из неё берутся системный промпт и модель. Роли заводятся в таблице AgentRole или ассистентом панели."
      />
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Роль общая для всех пайплайнов проекта, поэтому выбор ACP-агента сохраняется сразу — отдельно от кнопки «Сохранить» выше.
      </p>
      <ul className="divide-y rounded-lg border">
        {roles.map((role) => (
          <li key={role.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{role.title}</div>
              <div className="truncate font-mono text-xs text-muted-foreground">{role.key}</div>
            </div>
            <span className="w-48 shrink-0 truncate font-mono text-xs text-muted-foreground max-lg:hidden">
              {role.model ?? 'модель не задана'}
            </span>
            <Filter
              value={role.provider ?? NONE}
              onChange={(value) => { if (pick(value) && !readOnly) onPick(role.id, value); }}
              options={role.provider ? PROVIDERS : withNone('ACP-агент не выбран', PROVIDERS)}
              className={busy || readOnly ? 'pointer-events-none opacity-50' : undefined}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Этапы
// ---------------------------------------------------------------------------------------------

const RUNTIME_OPTIONS = [
  { value: 'host', label: 'Хост' },
  { value: 'docker', label: 'Docker' },
];

const ON_FAIL_OPTIONS = [
  { value: 'stop', label: 'остановить запуск' },
  { value: 'continue', label: 'продолжить' },
];

function StagesTab({
  doc,
  roles,
  readOnly,
  sourceKind,
  onPatch,
}: {
  doc: PipelineDoc;
  roles: PanelPipelineBoard['roles'];
  readOnly: boolean;
  sourceKind: PipelineSourceKind;
  onPatch: (next: (current: PipelineDoc) => PipelineDoc) => void;
}) {
  const [open, setOpen] = React.useState<number | null>(null);
  const stages = doc.stages ?? [];
  const workspacePipeline = sourceKind === 'worker_workspace';

  return (
    <div className="space-y-3">
      <ol className="divide-y rounded-lg border">
        {stages.map((stage, index) => {
          const role = roles.find((item) => item.key === stage.agentRoleKey);
          const expanded = open === index;
          return (
            <li key={`${index}-${stage.role}`} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="w-6 shrink-0 text-xs text-muted-foreground tabular-nums">{stage.order}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{stage.role}</span>
                <span className="w-44 shrink-0 truncate text-xs text-muted-foreground max-md:hidden">
                  {role ? role.title : `роль ${stage.agentRoleKey} не найдена`}
                </span>
                <span className="w-20 shrink-0 text-xs text-muted-foreground max-md:hidden">
                  {stage.runtime?.mode === 'docker' ? 'Docker' : 'Хост'}
                </span>
                <span className="w-40 shrink-0 truncate font-mono text-xs text-muted-foreground max-lg:hidden">
                  {stage.model ?? 'модель роли'}
                </span>
                {stage.verdict === true && <Badge variant="outline">вердикт</Badge>}
                {!readOnly && (
                  <Button variant="outline" size="sm" onClick={() => setOpen(expanded ? null : index)}>
                    {expanded ? 'Свернуть' : 'Настроить'}
                  </Button>
                )}
              </div>

              {expanded && !readOnly && (
                <div className="mt-3 space-y-3 rounded-lg border bg-muted/30 p-3">
                  <div className="flex flex-wrap items-end gap-4">
                    <label className="text-xs text-muted-foreground">
                      Название этапа
                      <Input
                        value={stage.role}
                        className="mt-1 h-8 w-56"
                        onChange={(event: React.ChangeEvent<HTMLInputElement>) => onPatch((current) => withStage(current, index, { role: event.target.value }))}
                      />
                    </label>
                    <label className="text-xs text-muted-foreground">
                      Роль агента
                      <div className="mt-1">
                        <Filter
                          value={stage.agentRoleKey}
                          onChange={(value) => onPatch((current) => withStage(current, index, { agentRoleKey: value }))}
                          // A stage may name a role that has since been renamed or deleted. It has
                          // to stay selected and readable — a blank select would hide the very
                          // thing the row above is complaining about.
                          options={roles.some((item) => item.key === stage.agentRoleKey)
                            ? roles.map((item) => ({ value: item.key, label: `${item.title} (${item.key})` }))
                            : [
                                { value: stage.agentRoleKey, label: `${stage.agentRoleKey} — роли нет в проекте` },
                                ...roles.map((item) => ({ value: item.key, label: `${item.title} (${item.key})` })),
                              ]}
                        />
                      </div>
                    </label>
                    <label className="text-xs text-muted-foreground">
                      Где выполняется
                      <div className="mt-1">
                        <Filter
                          value={stage.runtime?.mode ?? 'host'}
                          onChange={(value) => onPatch((current) => withStageRuntime(current, index, value as 'host' | 'docker'))}
                          // Docker is hidden for a pipeline working in a worker directory — a
                          // container cannot see it — unless the stage already says docker, in
                          // which case hiding it would render the select blank instead of showing
                          // the state the save is about to be rejected for.
                          options={workspacePipeline && stage.runtime?.mode !== 'docker' ? [RUNTIME_OPTIONS[0]] : RUNTIME_OPTIONS}
                        />
                      </div>
                    </label>
                    <label className="text-xs text-muted-foreground">
                      Если этап упал
                      <div className="mt-1">
                        <Filter
                          value={stage.onFail ?? 'stop'}
                          onChange={(value) => onPatch((current) => withStage(current, index, { onFail: value as 'stop' | 'continue' }))}
                          options={ON_FAIL_OPTIONS}
                        />
                      </div>
                    </label>
                  </div>

                  <label className="block text-xs text-muted-foreground">
                    Модель этого этапа
                    <Input
                      value={stage.model ?? ''}
                      placeholder={role?.model ? `модель роли: ${role.model}` : 'модель роли не задана'}
                      className="mt-1 h-8 max-w-lg"
                      onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                        const value = event.target.value.trim();
                        onPatch((current) => withStage(current, index, { model: value || undefined }));
                      }}
                    />
                    <span className="mt-1 block">
                      Переопределяет модель роли только для этого этапа. Пусто — модель роли. Ручной запуск сильнее обоих.
                    </span>
                  </label>

                  <label className="flex items-start gap-3 text-xs">
                    <Switch
                      checked={stage.verdict === true}
                      onCheckedChange={(value: boolean) => onPatch((current) => withStage(current, index, { verdict: value ? true : undefined }))}
                    />
                    <span className="text-muted-foreground">
                      Просить машинный вердикт. К промпту этапа добавляется требование напечатать
                      <code className="mx-1">AGENTIZ_VERDICT: pass</code> или <code className="mx-1">fail — причина</code>;
                      результат попадает в <code>AgentRun.verdict</code>, и воркфлоу ветвится по портам
                      <code className="mx-1">pass</code>/<code>fail</code> вместо <code className="mx-1">succeeded</code> —
                      ребро, привязанное к старому порту, повиснет.
                    </span>
                  </label>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" disabled={index === 0} onClick={() => onPatch((current) => moveStage(current, index, -1))}>Выше</Button>
                    <Button variant="outline" size="sm" disabled={index === stages.length - 1} onClick={() => onPatch((current) => moveStage(current, index, 1))}>Ниже</Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={stages.length < 2}
                      className="ml-auto text-destructive"
                      onClick={() => { setOpen(null); onPatch((current) => removeStage(current, index)); }}
                    >
                      Удалить этап
                    </Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {!readOnly && roles.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPatch((current) => addStage(current, roles[0].key, roles[0].title))}
        >
          Добавить этап
        </Button>
      )}

      <p className="text-xs text-muted-foreground">
        Этапы выполняются по порядку сверху вниз; каждый получает результаты предыдущих контекстом. Номера
        пересчитываются сами — спека требует 1..N без пропусков.
        {workspacePipeline && ' Docker недоступен: контейнер не видит папку воркера.'}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Источник
// ---------------------------------------------------------------------------------------------

const DELIVERY_OPTIONS = [
  { value: 'comment_only', label: 'Только результат в задаче' },
  { value: 'none', label: 'Ничего' },
  { value: 'commit', label: 'Коммит и push из папки' },
];

const BRANCH_MODE_OPTIONS = [
  { value: 'current', label: 'В исходную ветку' },
  { value: 'new', label: 'В новую короткую ветку' },
];

function SourceTab({
  doc,
  board,
  projectId,
  slug,
  readOnly,
  onPatch,
}: {
  doc: PipelineDoc;
  board: PanelPipelineBoard;
  projectId: string;
  slug: string;
  readOnly: boolean;
  onPatch: (next: (current: PipelineDoc) => PipelineDoc) => void;
}) {
  const kind = sourceKindOf(doc);
  const workspace = doc.source?.workspace;
  const worker = board.workers.find((item) => item.id === workspace?.workerId);

  /**
   * Directories this project may name. A declaration bound to another project is refused by the
   * model on save (`lib/workspaceOwnership.ts`), by key **and** by path — so it is not offered
   * here either, rather than offered and rejected after a press.
   */
  const ownDirectories = (item: PanelPipelineWorker | undefined) => (item?.workspaces ?? []).filter((entry) => {
    const owner = workspaceOwnerProjectId(item?.workspaces, { declared: entry });
    return !owner || owner === projectId;
  });

  const liveWorkers = board.workers.filter((item) => item.status !== 'revoked' || item.id === workspace?.workerId);
  const declaringWorkers = liveWorkers.filter((item) => ownDirectories(item).length > 0);

  /**
   * Which of the two ways the directory is named, as a control rather than as a reading of the
   * document. It starts from the spec and is then free to diverge: choosing «путь прямо здесь»
   * writes a workspace with no path yet, and a mode derived from the document would read that
   * back as «по ключу» and close the input in the same tick.
   */
  const [naming, setNaming] = React.useState<'key' | 'path'>(workspace?.path ? 'path' : 'key');

  const directory = workspaceDirectory(worker, workspace ? {
    workerId: workspace.workerId,
    workspaceKey: workspace.workspaceKey ?? null,
    path: workspace.path ?? null,
  } : null);
  const grant = pushGrant(worker, directory);

  const chooseWorkspace = (workerId: string, mode: 'key' | 'path') => {
    const machine = board.workers.find((item) => item.id === workerId);
    if (!machine) return;
    if (mode === 'key') {
      const first = ownDirectories(machine)[0];
      // No directory of this project on that machine: stay on the path form rather than silently
      // doing nothing to a select somebody just moved.
      if (!first) { setNaming('path'); return; }
      setNaming('key');
      onPatch((current) => withWorkspaceSource(current, { workerId, workspaceKey: first.key }, Boolean(pushGrant(machine, first.path))));
      return;
    }
    setNaming('path');
    const path = workspace?.path ?? '';
    onPatch((current) => withWorkspaceSource(current, { workerId, path }, Boolean(pushGrant(machine, path))));
  };

  return (
    <div className="space-y-6">
      <Section
        title="Где работает агент"
        description="Репозиторий — свежий клон через git-провайдера проекта, ветка на каждый запуск. Папка воркера — готовый каталог на конкретной машине; запуск прикрепляется к ней и уходит только на этого воркера."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <SourceCard
            title="Репозиторий"
            hint="Клон и ветка на каждый запуск"
            selected={kind === 'repository'}
            disabled={readOnly}
            onSelect={() => onPatch((current) => withRepositorySource(current, current.source?.repositoryId))}
          />
          <SourceCard
            title="Папка воркера"
            hint={liveWorkers.length === 0 ? 'Ни одного воркера пока нет' : 'Готовая папка, запуск закрепляется за машиной'}
            selected={kind === 'worker_workspace'}
            disabled={readOnly || liveWorkers.length === 0}
            onSelect={() => chooseWorkspace(workspace?.workerId ?? liveWorkers[0]?.id ?? '', declaringWorkers.length > 0 ? 'key' : 'path')}
          />
        </div>
      </Section>

      {kind === 'repository' && (
        <Section
          title="Какой репозиторий"
          description="Пусто — тот, из которого пришла задача: историческое поведение и правильное для проекта, где задачи и код живут вместе. Выбор нужен, когда это не так."
        >
          {board.repositories.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              К проекту не привязано ни одного репозитория — это делается на странице{' '}
              <a href={href('project.repositories', { slug })} className="underline">«Репозитории»</a>.
            </p>
          ) : (
            <Filter
              value={doc.source?.repositoryId ?? NONE}
              onChange={(value) => onPatch((current) => withRepositorySource(current, pick(value)))}
              options={withNone(
                'Репозиторий задачи',
                board.repositories.map((item) => ({ value: item.repositoryId, label: item.pathWithNamespace })),
              )}
              className={readOnly ? 'pointer-events-none opacity-50' : 'min-w-64'}
            />
          )}
        </Section>
      )}

      {kind === 'worker_workspace' && (
        <>
          <Section title="Какая папка" description="Ключ — каталог, объявленный на воркере заранее; путь — абсолютный путь прямо в спеке. Ровно одно из двух.">
            <div className="flex flex-wrap items-center gap-2">
              <Filter
                value={workspace?.workerId ?? NONE}
                onChange={(value) => { if (pick(value)) chooseWorkspace(value, naming); }}
                options={workspace
                  ? liveWorkers.map((item) => ({ value: item.id, label: item.name }))
                  : withNone('Воркер не выбран', liveWorkers.map((item) => ({ value: item.id, label: item.name })))}
                className={readOnly ? 'pointer-events-none opacity-50' : undefined}
              />
              <Filter
                value={naming}
                onChange={(value) => chooseWorkspace(workspace?.workerId ?? '', value as 'key' | 'path')}
                options={[
                  { value: 'key', label: 'По ключу, объявленному на воркере' },
                  { value: 'path', label: 'Путь прямо здесь' },
                ]}
                className={readOnly || declaringWorkers.length === 0 ? 'pointer-events-none opacity-50' : undefined}
              />
              {naming === 'key' && (
                <Filter
                  value={workspace?.workspaceKey ?? NONE}
                  onChange={(value) => {
                    if (!workspace || !pick(value)) return;
                    const declared = ownDirectories(worker).find((item) => item.key === value);
                    onPatch((current) => withWorkspaceSource(
                      current,
                      { workerId: workspace.workerId, workspaceKey: value },
                      Boolean(pushGrant(worker, declared?.path ?? '')),
                    ));
                  }}
                  options={(() => {
                    const declared = ownDirectories(worker).map((item) => ({
                      value: item.key,
                      label: item.label ? `${item.label} (${item.path})` : item.path,
                    }));
                    // A key the spec names but this project may no longer use (the operator bound
                    // the directory to another project since) must still be readable, or the
                    // select renders blank and the reason is nowhere on the screen.
                    const current = workspace?.workspaceKey;
                    return current && !declared.some((item) => item.value === current)
                      ? [...declared, { value: current, label: `${current} — папка недоступна проекту` }]
                      : declared;
                  })()}
                  className={readOnly ? 'pointer-events-none opacity-50' : 'min-w-64'}
                />
              )}
            </div>

            {naming === 'path' && (
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <Input
                  value={workspace?.path ?? ''}
                  placeholder="/srv/projects/monorepo"
                  disabled={readOnly}
                  className="h-8 w-72 font-mono"
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                    if (!workspace) return;
                    const path = event.target.value;
                    onPatch((current) => withWorkspaceSource(
                      current,
                      { workerId: workspace.workerId, path, createIfMissing: workspace.createIfMissing === true },
                      Boolean(pushGrant(worker, path.trim())),
                    ));
                  }}
                />
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch
                    checked={workspace?.createIfMissing === true}
                    disabled={readOnly}
                    onCheckedChange={(value: boolean) => {
                      if (!workspace) return;
                      onPatch((current) => withWorkspaceSource(
                        current,
                        { workerId: workspace.workerId, path: workspace.path ?? '', createIfMissing: value },
                        Boolean(grant),
                      ));
                    }}
                  />
                  Создать папку, если её нет
                </label>
              </div>
            )}

            {!directory && (
              <p className="mt-2 text-xs text-destructive">
                Папка не названа. Спека без ключа и без пути будет отклонена при сохранении.
              </p>
            )}
          </Section>

          <Section
            title="Чужие изменения в папке"
            description="Работа, лежавшая в папке к началу запуска, — не агента. По умолчанию воркер убирает её в git stash (sha попадает в лог запуска) и стартует с чистого дерева."
          >
            <label className="flex items-center gap-3 text-sm">
              <Switch
                checked={workspace?.stashDirty !== false}
                disabled={readOnly}
                onCheckedChange={(value: boolean) => onPatch((current) => withStashDirty(current, value))}
              />
              <span className="text-muted-foreground">
                {workspace?.stashDirty === false
                  ? 'Отказываться стартовать, пока папку не приведут в порядок руками'
                  : 'Убирать в git stash и продолжать'}
              </span>
            </label>
          </Section>

          <Section
            title="После стадий"
            description="Право на коммит и push — свойство воркера, а не спеки: его даёт администратор машины (gitPushRoots или git.pushEnabled у объявленной папки)."
          >
            <div className="flex flex-wrap items-center gap-2">
              <Filter
                value={String(doc.finalAction?.type ?? 'comment_only')}
                onChange={(value) => onPatch((current) => withWorkspaceDelivery(current, value as 'commit' | 'comment_only' | 'none'))}
                options={grant ? DELIVERY_OPTIONS : DELIVERY_OPTIONS.slice(0, 2)}
                className={readOnly ? 'pointer-events-none opacity-50' : 'min-w-64'}
              />
              {!grant && (
                <span className="text-xs text-muted-foreground">
                  Push из {directory ? <code>{directory}</code> : 'этой папки'} воркер не разрешает — это настраивается на{' '}
                  <a href={href('worker', { workerId: workspace?.workerId ?? '' })} className="underline">странице машины</a>.
                </span>
              )}
            </div>

            {doc.finalAction?.type === 'commit' && (
              <div className="mt-3 space-y-3 rounded-lg border bg-muted/30 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Filter
                    value={doc.source?.repositoryId ?? NONE}
                    onChange={(value) => onPatch((current) => withWorkspaceRepository(current, pick(value)))}
                    options={withNone(
                      `Remote самой папки (${grant?.remote ?? 'origin'})`,
                      board.repositories.map((item) => ({ value: item.repositoryId, label: item.pathWithNamespace })),
                    )}
                    className={readOnly ? 'pointer-events-none opacity-50' : 'min-w-64'}
                  />
                  <Filter
                    value={String(doc.finalAction?.targetBranch?.mode ?? 'new')}
                    onChange={(value) => onPatch((current) => withFinalAction(current, {
                      targetBranch: { ...(current.finalAction?.targetBranch ?? {}), mode: value as 'current' | 'new' },
                    }))}
                    options={BRANCH_MODE_OPTIONS}
                    className={readOnly ? 'pointer-events-none opacity-50' : undefined}
                  />
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Switch
                      checked={doc.finalAction?.requireApproval === true}
                      disabled={readOnly}
                      onCheckedChange={(value: boolean) => onPatch((current) => withFinalAction(current, { requireApproval: value }))}
                    />
                    Держать изменения до подтверждения человеком
                  </label>
                </div>
                {doc.finalAction?.targetBranch?.mode === 'new' && (
                  <label className="block text-xs text-muted-foreground">
                    Префикс ветки
                    <Input
                      value={String(doc.finalAction?.targetBranch?.prefix ?? 'agentiz/')}
                      disabled={readOnly}
                      className="mt-1 h-8 w-56 font-mono"
                      onChange={(event: React.ChangeEvent<HTMLInputElement>) => onPatch((current) => withFinalAction(current, {
                        targetBranch: { ...(current.finalAction?.targetBranch ?? {}), mode: 'new', prefix: event.target.value },
                      }))}
                    />
                  </label>
                )}
                <label className="block text-xs text-muted-foreground">
                  Шаблон сообщения коммита
                  <Textarea
                    value={String(doc.finalAction?.commitMessageTemplate ?? '')}
                    rows={3}
                    disabled={readOnly}
                    placeholder="{{title}}"
                    className="mt-1 font-mono text-xs"
                    onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => onPatch((current) => withFinalAction(current, {
                      commitMessageTemplate: event.target.value || undefined,
                    }))}
                  />
                  <span className="mt-1 block">Подстановки: {'{{taskId}} {{externalId}} {{title}} {{summary}}'}</span>
                </label>
              </div>
            )}
          </Section>
        </>
      )}

      <Separator />
      <Facts
        items={[
          ['Источник', kind === 'worker_workspace' ? 'Папка воркера' : 'Репозиторий'],
          ['Детали', kind === 'worker_workspace'
            ? `${worker?.name ?? '—'} · ${directory || 'папка не выбрана'}`
            : (board.repositories.find((item) => item.repositoryId === doc.source?.repositoryId)?.pathWithNamespace ?? 'репозиторий задачи')],
          ['Коммит и пуш', kind === 'worker_workspace'
            ? (grant ? `разрешены воркером, remote ${grant.remote}` : 'воркером не разрешены')
            : 'через ветку репозитория'],
        ]}
      />
    </div>
  );
}

function SourceCard({
  title,
  hint,
  selected,
  disabled,
  onSelect,
}: {
  title: string;
  hint: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const tone = selected ? 'border-primary bg-accent/40' : 'hover:bg-accent/50';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn('rounded-lg border p-3 text-left text-sm disabled:opacity-50', tone)}
    >
      <div className="font-medium">{title}</div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// Хуки
// ---------------------------------------------------------------------------------------------

const HOOK_POSITIONS: Array<{ key: HookPosition; title: string; hint: string }> = [
  {
    key: 'before',
    title: 'Перед первым этапом',
    hint: 'Выполняется, когда рабочая папка готова и до первой стадии: поставить зависимости, поднять базу, сгенерировать конфиг.',
  },
  {
    key: 'after',
    title: 'После последнего этапа',
    hint: 'Выполняется до сбора диффа — значит, форматтер или кодогенерация попадут в изменения запуска. Запускается и когда стадия упала, тогда AGENTIZ_RUN_STATUS=failed.',
  },
];

const INTERPRETER_OPTIONS = [
  { value: 'bash', label: 'bash' },
  { value: 'node', label: 'node' },
];

/** Monaco's language ids; `node` is plain JavaScript to it, `bash` is `shell`. */
const MONACO_LANGUAGE: Record<string, string> = { bash: 'shell', node: 'javascript' };

function scopeApplies(scope: HookVariableScope, sourceKind: PipelineSourceKind, position: HookPosition): boolean {
  if (scope === 'always') return true;
  if (scope === 'repository') return sourceKind === 'repository';
  if (scope === 'workspace') return sourceKind === 'worker_workspace';
  return position === 'after';
}

function HooksTab({
  doc,
  readOnly,
  sourceKind,
  onPatch,
}: {
  doc: PipelineDoc;
  readOnly: boolean;
  sourceKind: PipelineSourceKind;
  onPatch: (next: (current: PipelineDoc) => PipelineDoc) => void;
}) {
  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground">
        Оба скрипта выполняются на воркере, в той же папке, где работает агент. Значения приезжают обычными
        переменными окружения и никогда не подставляются в текст скрипта — поэтому название задачи из чужого
        трекера не может стать командой. Токен доступа к репозиторию хукам не выдаётся.
      </p>

      {HOOK_POSITIONS.map((entry) => (
        <HookEditor
          key={entry.key}
          position={entry.key}
          title={entry.title}
          hint={entry.hint}
          hook={doc.hooks?.[entry.key]}
          sourceKind={sourceKind}
          readOnly={readOnly}
          onChange={(next) => onPatch((current) => withHook(current, entry.key, next))}
        />
      ))}
    </div>
  );
}

function HookEditor({
  position,
  title,
  hint,
  hook,
  sourceKind,
  readOnly,
  onChange,
}: {
  position: HookPosition;
  title: string;
  hint: string;
  hook: PipelineHookDoc | undefined;
  sourceKind: PipelineSourceKind;
  readOnly: boolean;
  onChange: (next: PipelineHookDoc | undefined) => void;
}) {
  const enabled = Boolean(hook);
  const interpreter = hook?.interpreter ?? 'bash';
  const script = hook?.script ?? '';

  // Unknown `$AGENTIZ_*` names are read by `lib/hookEnv.ts` — the same module the server builds the
  // environment from and the worker exports it with. A misspelling expands to an empty string, so
  // it is worth saying out loud; it does not block saving, because a script may define its own.
  const unknown = React.useMemo(() => [...new Set(unknownHookVariables(script).map((item) => item.name))], [script]);
  const outOfScope = React.useMemo(() => {
    const mentioned = new Set(
      [...script.matchAll(/\$\{?(AGENTIZ_[A-Z0-9_]*)\}?/g)].map((match) => match[1]),
    );
    return HOOK_VARIABLES
      .filter((variable) => mentioned.has(variable.name) && !scopeApplies(variable.scope, sourceKind, position))
      .map((variable) => variable.name);
  }, [script, sourceKind, position]);

  const available = HOOK_VARIABLES.filter((variable) => scopeApplies(variable.scope, sourceKind, position));

  return (
    <section className="rounded-lg border p-3">
      <label className="flex items-center gap-3 text-sm font-medium">
        <Switch
          checked={enabled}
          disabled={readOnly}
          onCheckedChange={(value: boolean) => onChange(value ? { interpreter: 'bash', script: '' } : undefined)}
        />
        {title}
      </label>
      <p className="mt-1 max-w-3xl text-xs text-muted-foreground">{hint}</p>

      {enabled && hook && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-end gap-4">
            <label className="text-xs text-muted-foreground">
              Чем исполнять
              <div className="mt-1">
                <Filter
                  value={interpreter}
                  onChange={(value) => onChange({ ...hook, interpreter: value as 'bash' | 'node' })}
                  options={INTERPRETER_OPTIONS}
                  className={readOnly ? 'pointer-events-none opacity-50' : undefined}
                />
              </div>
            </label>
            <label className="text-xs text-muted-foreground">
              Таймаут, секунд
              <Input
                type="number"
                min={1}
                max={3600}
                value={String(hook.timeoutSec ?? DEFAULT_HOOK_TIMEOUT_SEC)}
                disabled={readOnly}
                className="mt-1 h-8 w-24"
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                  const value = Number(event.target.value);
                  onChange({ ...hook, timeoutSec: Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined });
                }}
              />
            </label>
            <label className="text-xs text-muted-foreground">
              Если упал
              <div className="mt-1">
                <Filter
                  value={hook.onFail ?? 'stop'}
                  onChange={(value) => onChange({ ...hook, onFail: value as 'stop' | 'continue' })}
                  options={ON_FAIL_OPTIONS}
                  className={readOnly ? 'pointer-events-none opacity-50' : undefined}
                />
              </div>
            </label>
          </div>

          {MonacoEditor ? (
            <MonacoEditor
              value={script}
              onChange={(value: string) => onChange({ ...hook, script: value })}
              options={{ language: MONACO_LANGUAGE[interpreter] ?? 'plaintext' }}
              disabled={readOnly}
            />
          ) : (
            <Textarea
              value={script}
              rows={10}
              disabled={readOnly}
              className="font-mono text-xs"
              onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => onChange({ ...hook, script: event.target.value })}
            />
          )}

          <p className="text-xs text-muted-foreground">
            Строка <code>#!</code> не нужна — воркер подставит её сам по выбранному интерпретатору.
            {interpreter === 'bash' && ' Запускается как bash -e -o pipefail: первая же неуспешная команда завершает скрипт.'}
          </p>

          {unknown.length > 0 && (
            <p className="text-xs text-destructive">
              Agentiz не определяет {unknown.join(', ')}. Если скрипт задаёт эти имена сам — предупреждение можно не читать.
            </p>
          )}
          {outOfScope.length > 0 && (
            <p className="text-xs agentiz-attention">
              {outOfScope.join(', ')} — здесь будут пустыми: такие переменные появляются у пайплайна другого вида.
            </p>
          )}

          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Доступные переменные ({available.length})</summary>
            <div className="mt-2 space-y-1">
              {available.map((variable) => (
                <div key={variable.name} className="flex gap-2">
                  <code className="shrink-0 font-medium">${variable.name}</code>
                  <span className="text-muted-foreground">{variable.description}</span>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </section>
  );
}
