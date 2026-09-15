import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { href } from '../../../lib/panel/routeTree';
import { Filter, FilterBar, SearchInput } from './blocks';
import { ago, plural } from './format';
import { EmptyState, Facts, PageHeader } from './page';
import { StatusBadge } from './status';
import { toast } from './ui';
import { formatDateTime, useViewerTimezone } from './viewerTime';

/**
 * The three repository screens: the repositories of one project, the installation's git providers,
 * and one provider in full.
 *
 * They are one file because they are one subject seen from two sides of a boundary that this
 * rework exists to draw. A *project* works with repositories — which ones, in which branch, whether
 * their events reach us. An *installation* owns accounts and OAuth applications, and a project
 * neither configures them nor sees a secret of theirs. The old screen mixed the two and put a
 * project selector on top of an installation-wide page.
 *
 * What is **not** here, and must not be: any knowledge of GitHub or GitLab. Both live in their own
 * layers and describe themselves through the `gitProviderPanels` collection (see
 * `lib/git/providerPanels.ts`), so everything platform-shaped on these screens — the name, the
 * OAuth application's fields, where such an application is created, the scopes — arrives as data.
 * A third platform is a layer, not an edit here.
 *
 * Every write already existed and is already used by the screens this replaces: `linkRepository`,
 * `unlinkRepository`, `updateProjectRepository`, `syncConnectionRepositories`,
 * `disconnectConnection`, `deleteConnection` in the core, and `createOAuthApp` / `deleteOAuthApp` /
 * `startOAuth` at the provider's own route. The port adds no verb.
 */

const PREFIX: string = (window as any).routePrefix ?? '/dashboard';
const REPOS_API = `${PREFIX}/agentiz-repos`;
const axios = (window as any).axios;

// ---------------------------------------------------------------------------------------------
// Wire shapes — what `lib/panel/repositoriesPanel.ts` sends.
// ---------------------------------------------------------------------------------------------

export interface PanelRepositoryWebhook {
  installed: boolean;
  url: string | null;
  installedAt: string | null;
  lastDeliveryAt: string | null;
  lastError: string | null;
  events: string[] | null;
}

export interface PanelRepositoryWatch {
  branches: Array<{ branch: string; sha: string }>;
  branchCount: number;
  lastCiRunId: number | null;
  checkedAt: string | null;
}

export interface ProjectRepositoryRow {
  id: string;
  projectId: string;
  repositoryId: string;
  provider: string;
  providerTitle: string;
  role: string;
  isPrimary: boolean;
  syncIssues: boolean;
  isActive: boolean;
  config: Record<string, any> | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  repository: {
    id: string;
    pathWithNamespace: string;
    name: string | null;
    webUrl: string | null;
    cloneUrl: string | null;
    defaultBranch: string | null;
    visibility: string | null;
    lastActivityAt: string | null;
  } | null;
  connection: {
    id: string;
    username: string | null;
    displayName: string | null;
    baseUrl: string | null;
    status: string;
  } | null;
  webhook: PanelRepositoryWebhook | null;
  watch: PanelRepositoryWatch | null;
  lastEvent: { type: string; badge: string; title: string; createdAt: string } | null;
}

export interface GitProviderPanelField {
  name: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  required?: boolean;
  hint?: string;
}

export interface GitConnectionRow {
  id: string;
  provider: string;
  username: string | null;
  displayName: string | null;
  baseUrl: string | null;
  status: string;
  scope: string | null;
  expiresAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  repositoryCount: number;
  hasSecrets: boolean;
}

export interface GitProviderCard {
  provider: string;
  title: string;
  summary: string;
  apiRoute: string | null;
  href: string;
  described: boolean;
  authorityMounted: boolean;
  appFields: GitProviderPanelField[];
  appIdentityField: string;
  appHint: string;
  defaultScopes: string[];
  connections: GitConnectionRow[];
  repositoryCount: number;
}

/** One OAuth application, as the provider layer's `getOAuthApps` answers. */
interface OAuthApp {
  id: string;
  name: string;
  baseUrl: string;
  callbackUrl: string;
  scopes: string[] | null;
  isActive: boolean;
  [field: string]: unknown;
}

const ROLE_OPTIONS = [
  { value: 'both', label: 'Источник и цель' },
  { value: 'source', label: 'Источник задач' },
  { value: 'target', label: 'Цель коммитов' },
];

function roleLabel(role: string): string {
  return ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role;
}

/** The instance a connection points at, short enough for a row: `git.hm`, `github.com`. */
function instanceOf(baseUrl: string | null | undefined): string {
  if (!baseUrl) return '';
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
}

/**
 * What to say about the hook, and it is deliberately never an alarm.
 *
 * No hook is a **supported state** (AGENTS.md, `docs/guides/repository-events.md`): no
 * `AGENTIZ_PUBLIC_URL`, no receiving layer, a connection whose organisation trimmed its scope. The
 * repository is still watched — the 15-minute poll carries it — so the row says what is happening
 * and why, and leaves red for things that are actually broken.
 */
function webhookPhrase(webhook: PanelRepositoryWebhook | null): string {
  if (!webhook) return 'Вебхук не ставился — репозиторий наблюдается опросом';
  if (webhook.installed) {
    return webhook.lastDeliveryAt
      ? `Вебхук: установлен, последняя доставка ${ago(webhook.lastDeliveryAt)} назад`
      : 'Вебхук: установлен, доставок ещё не было';
  }
  return webhook.lastError
    ? `Вебхука нет: ${webhook.lastError} — наблюдение идёт опросом`
    : 'Вебхука нет — наблюдение идёт опросом';
}

/** Where the two observers of this repository left off. Empty cursor = ещё ни одного прохода. */
function watchPhrase(watch: PanelRepositoryWatch | null): string {
  if (!watch || watch.branchCount === 0) return 'Курсор наблюдения пуст — первого прохода ещё не было';
  const head = watch.branches[0];
  const rest = watch.branchCount - watch.branches.length;
  const tail = rest > 0 ? ` и ещё ${rest}` : '';
  return `Курсор наблюдения: ${head.branch} @ ${head.sha.slice(0, 7)}${tail}`;
}

// ---------------------------------------------------------------------------------------------
// The repositories of a project
// ---------------------------------------------------------------------------------------------

/** A mirrored repository as the picker sees it — the answer of `_method=getRepositories`. */
interface PickableRepository {
  id: string;
  provider: string;
  pathWithNamespace: string;
  defaultBranch: string | null;
  visibility: string | null;
}

function RepositorySettings({
  row,
  busy,
  onPatch,
  onUnlink,
}: {
  row: ProjectRepositoryRow;
  busy: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
  onUnlink: () => void;
}) {
  return (
    <div className="mt-3 space-y-3 rounded-lg border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Роль
          <Filter value={row.role} onChange={(value) => onPatch({ role: value })} options={ROLE_OPTIONS} />
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Ветка проекта
          <Input
            defaultValue={row.config?.defaultBranch ?? ''}
            placeholder={row.repository?.defaultBranch ?? 'по умолчанию'}
            disabled={busy}
            className="h-8 w-44"
            onBlur={(event: React.FocusEvent<HTMLInputElement>) => {
              const value = event.target.value.trim();
              if (value === (row.config?.defaultBranch ?? '')) return;
              // `config` is written as a unit, so it is merged here rather than replaced: the same
              // column carries `pollIntervalSec` and `query`, which this screen never shows.
              onPatch({ config: { ...(row.config ?? {}), defaultBranch: value || undefined } });
            }}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-6">
        <label className="flex items-center gap-2 text-xs">
          <Switch checked={row.syncIssues} disabled={busy} onCheckedChange={(value: boolean) => onPatch({ syncIssues: value })} />
          Синхронизировать задачи
        </label>
        <label className="flex items-center gap-2 text-xs">
          <Switch checked={row.isActive} disabled={busy} onCheckedChange={(value: boolean) => onPatch({ isActive: value })} />
          Связь активна
        </label>
        {/* One primary per project, and the server demotes the previous one on write — so this is
            a promotion, not a toggle: there is no "снять основной", only "назначить другой". */}
        {row.isPrimary ? (
          <span className="text-xs text-muted-foreground">Основной репозиторий проекта</span>
        ) : (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onPatch({ isPrimary: true })}>
            Сделать основным
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={busy} className="ml-auto text-destructive" onClick={onUnlink}>
          Отвязать
        </Button>
      </div>
    </div>
  );
}

function RepositoryRow({
  row,
  canConfigure,
  busy,
  onPatch,
  onUnlink,
}: {
  row: ProjectRepositoryRow;
  canConfigure: boolean;
  busy: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
  onUnlink: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const path = row.repository?.pathWithNamespace ?? 'репозиторий удалён';
  const instance = instanceOf(row.connection?.baseUrl);
  const status = row.isActive ? 'active' : 'inactive';

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {row.repository?.webUrl ? (
              <a href={row.repository.webUrl} className="truncate text-sm font-medium hover:underline">{path}</a>
            ) : (
              <span className="truncate text-sm font-medium">{path}</span>
            )}
            {row.isPrimary && <Badge variant="outline">основной</Badge>}
            <Badge variant="outline">{roleLabel(row.role)}</Badge>
          </div>
          <div className="truncate font-mono text-xs text-muted-foreground">{row.repository?.cloneUrl ?? '—'}</div>
        </div>
        <span className="w-40 shrink-0 truncate text-xs text-muted-foreground max-lg:hidden">
          {row.providerTitle}{instance ? ` (${instance})` : ''}
        </span>
        <span className="w-28 shrink-0 truncate font-mono text-xs text-muted-foreground max-lg:hidden">
          {row.config?.defaultBranch ?? row.repository?.defaultBranch ?? '—'}
        </span>
        <StatusBadge status={status} className="w-24 shrink-0 justify-center" />
        {canConfigure && (
          <Button variant="outline" size="sm" onClick={() => setOpen((value) => !value)}>
            {open ? 'Свернуть' : 'Настроить'}
          </Button>
        )}
      </div>

      <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
        <span>{webhookPhrase(row.webhook)}</span>
        <span title={row.lastEvent?.title ?? undefined}>
          {row.lastEvent
            ? `Последнее событие: ${row.lastEvent.badge}, ${ago(row.lastEvent.createdAt)} назад`
            : 'Событий ещё не приходило'}
        </span>
        <span>{watchPhrase(row.watch)}</span>
      </div>
      {row.lastError && <p className="mt-1 text-xs text-destructive">{row.lastError}</p>}

      {open && canConfigure && <RepositorySettings row={row} busy={busy} onPatch={onPatch} onUnlink={onUnlink} />}
    </li>
  );
}

function RepositoryPicker({
  linked,
  busy,
  onPick,
  onClose,
}: {
  linked: Set<string>;
  busy: boolean;
  onPick: (repositoryId: string) => void;
  onClose: () => void;
}) {
  const [items, setItems] = React.useState<PickableRepository[] | null>(null);
  const [search, setSearch] = React.useState('');
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await axios.get(REPOS_API, { params: { _method: 'getRepositories' } });
        if (!cancelled) setItems(response.data?.data ?? []);
      } catch {
        // The catalogue is installation-wide and behind the connections token; a project
        // configurator who does not hold it gets an explanation, not an empty list.
        if (!cancelled) setFailed(true);
      }
    })();
    return (): void => { cancelled = true; };
  }, []);

  const needle = search.trim().toLowerCase();
  const shown = (items ?? [])
    .filter((item) => !linked.has(item.id))
    .filter((item) => !needle || item.pathWithNamespace.toLowerCase().includes(needle))
    .slice(0, 50);

  return (
    <div className="mb-4 rounded-lg border p-3">
      <FilterBar>
        <SearchInput value={search} onChange={setSearch} placeholder="Путь репозитория" />
        <span className="text-xs text-muted-foreground">
          Только уже зеркалированные репозитории подключённых учётных записей. Нового здесь нет, пока учётку не синхронизировали.
        </span>
        <Button variant="outline" size="sm" className="ml-auto" onClick={onClose}>Отмена</Button>
      </FilterBar>

      {failed ? (
        <p className="text-xs text-muted-foreground">
          Каталог репозиториев ведут администраторы установки — на него нужен доступ к разделу «Git-провайдеры».
        </p>
      ) : items === null ? (
        <p className="text-xs text-muted-foreground">Загружаем…</p>
      ) : shown.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Ничего не найдено. Если репозиторий новый — синхронизируйте учётную запись на странице провайдера.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {shown.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <code className="min-w-0 flex-1 truncate text-xs">{item.pathWithNamespace}</code>
              <span className="text-xs text-muted-foreground">
                {[item.defaultBranch, item.visibility].filter(Boolean).join(' · ')}
              </span>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => onPick(item.id)}>Привязать</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * «Репозитории» проекта — what this project works with, and nothing about accounts.
 *
 * Server-rendered once and re-read after every write through the same builder, so the row a person
 * sees after pressing a button is built by the same code that painted the page.
 */
export function ProjectRepositoriesScreen({
  initial,
  projectId,
  canConfigure,
  canManageConnections,
}: {
  initial: ProjectRepositoryRow[];
  projectId: string;
  canConfigure: boolean;
  canManageConnections: boolean;
}) {
  useViewerTimezone();
  const [rows, setRows] = React.useState<ProjectRepositoryRow[]>(initial);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [picking, setPicking] = React.useState(false);

  const reload = React.useCallback(async () => {
    const response = await axios.get(REPOS_API, { params: { _method: 'getRepositoryBoard', projectId } });
    setRows(response.data?.data ?? []);
  }, [projectId]);

  const write = React.useCallback(async (id: string, payload: Record<string, unknown>, done: string) => {
    setBusyId(id);
    try {
      await axios.post(REPOS_API, payload);
      toast.success(done);
      await reload();
    } catch (error: any) {
      toast.error(error?.response?.data?.message ?? 'Запрос не удался');
    } finally {
      setBusyId(null);
    }
  }, [reload]);

  const linked = new Set(rows.map((row) => row.repositoryId));
  const watched = rows.filter((row) => row.isActive).length;

  return (
    <>
      <PageHeader
        title="Репозитории"
        meta={[
          <span key="count">{rows.length} {plural(rows.length, 'репозиторий', 'репозитория', 'репозиториев')}</span>,
          rows.length > 0 ? <span key="watched">{watched} наблюдаются</span> : null,
        ]}
        description="Здесь только то, с чем работает проект. Учётные записи и OAuth-приложения — в разделе интеграций уровня установки."
        actions={canConfigure && (
          <Button onClick={() => setPicking((value) => !value)} disabled={!canManageConnections}>
            Добавить репозиторий
          </Button>
        )}
      />

      {canConfigure && !canManageConnections && (
        <p className="mb-3 text-xs text-muted-foreground">
          Привязать новый репозиторий может тот, у кого есть доступ к git-подключениям установки: каталог общий для всех проектов.
        </p>
      )}

      {picking && canConfigure && canManageConnections && (
        <RepositoryPicker
          linked={linked}
          busy={busyId !== null}
          onClose={() => setPicking(false)}
          onPick={async (repositoryId) => {
            setPicking(false);
            await write(repositoryId, { _method: 'linkRepository', projectId, repositoryId }, 'Репозиторий привязан');
          }}
        />
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="Репозиториев нет"
          description="Проект работает с кодом через привязанный репозиторий: в нём агент делает ветку, коммит и пуш, из него же приходят события для воркфлоу."
        />
      ) : (
        <ul className="divide-y rounded-lg border">
          {rows.map((row) => (
            <RepositoryRow
              key={row.id}
              row={row}
              canConfigure={canConfigure}
              busy={busyId !== null}
              onPatch={(patch) => void write(row.id, { _method: 'updateProjectRepository', linkId: row.id, ...patch }, 'Сохранено')}
              onUnlink={() => {
                if (!window.confirm('Отвязать репозиторий от проекта? Синхронизированные задачи останутся.')) return;
                void write(row.id, { _method: 'unlinkRepository', linkId: row.id }, 'Репозиторий отвязан');
              }}
            />
          ))}
        </ul>
      )}

      <Separator className="my-6" />
      <Facts
        items={[
          ['Учётные записи и приложения', canManageConnections
            ? <a href={href('integrations.git')} className="hover:underline">Git-провайдеры</a>
            : 'раздел установки, отдельный доступ'],
          ['Кто ставит вебхук', 'сервер, один хук на репозиторий, а не на связку с проектом'],
          ['Если хука нет', 'опрос раз в 15 минут — это рабочее состояние, а не ошибка'],
        ]}
      />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Git providers: the installation's accounts
// ---------------------------------------------------------------------------------------------

function ConnectionRow({ connection, children }: { connection: GitConnectionRow; children?: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-2.5">
      <span className="w-40 shrink-0 truncate text-sm">{connection.username ?? connection.displayName ?? connection.id.slice(0, 8)}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={connection.scope ?? undefined}>
        {connection.scope ?? 'скоупы не сохранились'}
      </span>
      <StatusBadge status={connection.status} className="shrink-0" />
      <span className="w-32 shrink-0 text-right text-xs text-muted-foreground">
        {connection.repositoryCount} {plural(connection.repositoryCount, 'репозиторий', 'репозитория', 'репозиториев')}
      </span>
      <span className="w-44 shrink-0 text-right text-xs text-muted-foreground">
        {/* A GitHub OAuth App usually issues a token that never expires; «бессрочный» is the
            honest word for `null` and not something to leave blank. */}
        {connection.expiresAt ? `токен до ${formatDateTime(connection.expiresAt)}` : 'токен бессрочный'}
      </span>
      {children}
    </li>
  );
}

/** «Git-провайдеры» — one card per platform, however many are mounted. */
export function GitProvidersScreen({ providers }: { providers: GitProviderCard[] }) {
  useViewerTimezone();
  // «OAuth-приложение настроено» is the one fact on this screen the core cannot answer: the
  // applications are the layer's own table. It is asked at the layer's own route, the address of
  // which came from the layer too — and a provider that refuses to answer simply says nothing.
  const [apps, setApps] = React.useState<Record<string, number>>({});

  React.useEffect(() => {
    let cancelled = false;
    for (const provider of providers) {
      if (!provider.apiRoute) continue;
      void (async () => {
        try {
          const response = await axios.get(`${PREFIX}${provider.apiRoute}`, { params: { _method: 'getOAuthApps' } });
          if (!cancelled) setApps((current) => ({ ...current, [provider.provider]: (response.data?.data ?? []).length }));
        } catch { /* the card is complete without it */ }
      })();
    }
    return (): void => { cancelled = true; };
  }, [providers]);

  return (
    <>
      <PageHeader
        title="Git-провайдеры"
        description="Учётные записи и OAuth-приложения уровня установки. В проекте выбирают уже готовый репозиторий и секретов не видят."
      />

      {providers.length === 0 ? (
        <EmptyState
          title="Ни одной платформы"
          description="Слой GitHub или GitLab не смонтирован, и ни одного подключения в базе тоже нет."
        />
      ) : (
        <div className="space-y-4">
          {providers.map((provider) => {
            const appCount = apps[provider.provider];
            const summary = [
              `${provider.connections.length} ${plural(provider.connections.length, 'учётная запись', 'учётные записи', 'учётных записей')}`,
              `${provider.repositoryCount} ${plural(provider.repositoryCount, 'репозиторий', 'репозитория', 'репозиториев')}`,
              appCount === undefined ? null : appCount > 0 ? 'OAuth-приложение настроено' : 'OAuth-приложения нет',
            ].filter(Boolean).join(' · ');
            const live = provider.connections.some((connection) => connection.status === 'active');

            return (
              <div key={provider.provider} className="rounded-lg border">
                <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{provider.title}</div>
                    <div className="text-xs text-muted-foreground">{summary}</div>
                  </div>
                  <StatusBadge status={live ? 'active' : 'inactive'} className="shrink-0" />
                  <Button asChild variant="outline" size="sm"><a href={provider.href}>Управлять</a></Button>
                </div>
                {provider.connections.length === 0 ? (
                  <p className="px-4 py-3 text-xs text-muted-foreground">
                    {provider.described
                      ? 'Ни одной учётной записи. Начните с OAuth-приложения на странице провайдера.'
                      : 'Слой этой платформы не смонтирован: подключений нет и создать их нечем.'}
                  </p>
                ) : (
                  <ul className="divide-y">
                    {provider.connections.map((connection) => <ConnectionRow key={connection.id} connection={connection} />)}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// One provider
// ---------------------------------------------------------------------------------------------

function OAuthAppForm({
  fields,
  busy,
  onSubmit,
  onCancel,
}: {
  fields: GitProviderPanelField[];
  busy: boolean;
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = React.useState<Record<string, string>>({});
  const missing = fields.some((field) => field.required && !(values[field.name] ?? '').trim());

  return (
    <div className="mb-4 rounded-lg border p-3">
      <div className="grid gap-3 md:grid-cols-2">
        {fields.map((field) => (
          <label key={field.name} className="text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">
              {field.label}{field.required ? ' *' : ''}
            </span>
            <Input
              type={field.secret ? 'password' : 'text'}
              value={values[field.name] ?? ''}
              placeholder={field.placeholder}
              disabled={busy}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                setValues((current) => ({ ...current, [field.name]: event.target.value }))}
            />
            {field.hint && <span className="mt-1 block text-xs text-muted-foreground">{field.hint}</span>}
          </label>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <Button size="sm" disabled={busy || missing} onClick={() => onSubmit(values)}>Сохранить</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>Отмена</Button>
      </div>
    </div>
  );
}

/** One platform in full: its OAuth applications and the accounts authorized through them. */
export function GitProviderScreen({ provider }: { provider: GitProviderCard | null }) {
  useViewerTimezone();
  const [apps, setApps] = React.useState<OAuthApp[]>([]);
  const [connections, setConnections] = React.useState<GitConnectionRow[]>(provider?.connections ?? []);
  const [adding, setAdding] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const apiRoute = provider?.apiRoute ?? null;
  const providerApi = apiRoute ? `${PREFIX}${apiRoute}` : null;

  const loadApps = React.useCallback(async () => {
    if (!providerApi) return;
    try {
      const response = await axios.get(providerApi, { params: { _method: 'getOAuthApps' } });
      setApps(response.data?.data ?? []);
    } catch (error: any) {
      toast.error(error?.response?.data?.message ?? 'Не удалось загрузить OAuth-приложения');
    }
  }, [providerApi]);

  const loadConnections = React.useCallback(async () => {
    if (!provider) return;
    try {
      const response = await axios.get(REPOS_API, { params: { _method: 'getConnections' } });
      const all: GitConnectionRow[] = response.data?.data ?? [];
      setConnections(all.filter((connection) => connection.provider === provider.provider));
    } catch { /* the page keeps the rows it was rendered with */ }
  }, [provider]);

  React.useEffect(() => { void loadApps(); }, [loadApps]);

  const call = React.useCallback(async (url: string, payload: Record<string, unknown>) => {
    setBusy(true);
    try {
      const response = await axios.post(url, payload);
      return response.data?.data;
    } catch (error: any) {
      toast.error(error?.response?.data?.message ?? 'Запрос не удался');
      throw error;
    } finally {
      setBusy(false);
    }
  }, []);

  if (!provider) {
    return (
      <EmptyState
        title="Такой платформы нет"
        description="Ни один смонтированный слой её не описывает и ни одного подключения с таким именем в базе нет."
        action={<Button asChild variant="outline"><a href={href('integrations.git')}>Ко всем провайдерам</a></Button>}
      />
    );
  }

  return (
    <>
      <PageHeader
        title={provider.title}
        meta={[
          <span key="conn">{connections.length} {plural(connections.length, 'учётная запись', 'учётные записи', 'учётных записей')}</span>,
          <span key="repos">{provider.repositoryCount} {plural(provider.repositoryCount, 'репозиторий', 'репозитория', 'репозиториев')}</span>,
        ]}
        description={provider.summary}
        actions={provider.described && (
          <Button onClick={() => setAdding((value) => !value)}>Добавить приложение</Button>
        )}
      />

      {!provider.described && (
        <p className="mb-4 rounded-lg border p-3 text-sm text-muted-foreground">
          Слой этой платформы не смонтирован. Подключения ниже остаются в базе и их репозитории продолжают работать, но
          обновить токен, пересинхронизировать репозитории и авторизовать новый аккаунт нечем.
        </p>
      )}

      {adding && provider.described && (
        <OAuthAppForm
          fields={provider.appFields}
          busy={busy}
          onCancel={() => setAdding(false)}
          onSubmit={async (values) => {
            if (!providerApi) return;
            await call(providerApi, { _method: 'createOAuthApp', ...values });
            setAdding(false);
            toast.success('Приложение сохранено');
            await loadApps();
          }}
        />
      )}

      {provider.described && (
        <div className="mb-6">
          <h2 className="mb-1.5 text-xs font-medium text-muted-foreground">OAuth-приложения</h2>
          {apps.length === 0 ? (
            <EmptyState title="Приложений пока нет" description={provider.appHint} />
          ) : (
            <ul className="divide-y rounded-lg border">
              {apps.map((app) => (
                <li key={app.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">{app.name}</span>
                        {!app.isActive && <Badge variant="outline">выключено</Badge>}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {app.baseUrl} · {provider.appIdentityField}: {String(app[provider.appIdentityField] ?? '—')}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      disabled={busy || !app.isActive}
                      onClick={async () => {
                        if (!providerApi) return;
                        const data = await call(providerApi, {
                          _method: 'startOAuth',
                          oauthAppId: app.id,
                          // The OAuth callback is registered at the platform and does not move; it
                          // brings the browser back to whatever address asked, which is now this one.
                          returnTo: window.location.pathname,
                        });
                        if (data?.authorizeUrl) window.location.href = data.authorizeUrl;
                      }}
                    >
                      Подключить аккаунт
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      className="text-destructive"
                      onClick={async () => {
                        if (!providerApi) return;
                        if (!window.confirm('Удалить приложение? Выданные через него подключения перестанут обновлять токен.')) return;
                        await call(providerApi, { _method: 'deleteOAuthApp', id: app.id });
                        toast.success('Приложение удалено');
                        await loadApps();
                      }}
                    >
                      Удалить
                    </Button>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                    {/* The field people get wrong most often, so it is printed ready to paste. */}
                    <span className="font-mono">callback: {app.callbackUrl}</span>
                    <span className="font-mono">{(app.scopes ?? provider.defaultScopes).join(' ') || 'скоупы по умолчанию'}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <h2 className="mb-1.5 text-xs font-medium text-muted-foreground">Учётные записи</h2>
      {connections.length === 0 ? (
        <EmptyState
          title="Ни одного аккаунта"
          description="Аккаунт авторизуется через OAuth-приложение выше, и уже он зеркалирует репозитории, которые проекты потом выбирают."
        />
      ) : (
        <ul className="divide-y rounded-lg border">
          {connections.map((connection) => (
            <ConnectionRow key={connection.id} connection={connection}>
              <div className="flex w-full flex-wrap items-center gap-2">
                {connection.lastError && <span className="min-w-0 flex-1 truncate text-xs text-destructive">{connection.lastError}</span>}
                <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                  {connection.lastSyncedAt ? `синхронизировано ${ago(connection.lastSyncedAt)} назад` : 'ни разу не синхронизировано'}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !provider.authorityMounted || connection.status !== 'active'}
                  onClick={async () => {
                    await call(REPOS_API, { _method: 'syncConnectionRepositories', connectionId: connection.id });
                    toast.success('Репозитории обновлены');
                    await loadConnections();
                  }}
                >
                  Синхронизировать репозитории
                </Button>
                {connection.status === 'active' && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={async () => {
                      if (!window.confirm('Отключить аккаунт? Токен будет отозван, привязки к проектам останутся.')) return;
                      await call(REPOS_API, { _method: 'disconnectConnection', connectionId: connection.id });
                      toast.success('Аккаунт отключён');
                      await loadConnections();
                    }}
                  >
                    Отключить
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  className="text-destructive"
                  onClick={async () => {
                    if (!window.confirm('Удалить подключение? Вместе с ним исчезнут его репозитории и привязки проектов.')) return;
                    await call(REPOS_API, { _method: 'deleteConnection', connectionId: connection.id });
                    toast.success('Подключение удалено');
                    await loadConnections();
                  }}
                >
                  Удалить
                </Button>
              </div>
            </ConnectionRow>
          ))}
        </ul>
      )}

      <Separator className="my-6" />
      <Facts
        items={[
          ['Где создаётся приложение', provider.appHint],
          ['Запрашиваемые скоупы', <span key="s" className="font-mono">{provider.defaultScopes.join(' ') || '—'}</span>],
          ['Секреты', 'хранятся на сервере и наружу не выходят: и client secret приложения, и токен аккаунта видны только как маска'],
        ]}
      />
    </>
  );
}
