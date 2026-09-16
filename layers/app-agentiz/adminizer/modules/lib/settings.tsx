import * as React from 'react';
import { Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { href, PROJECT_SETTINGS_TITLES, type ProjectSettingsSection } from '../../../lib/panel/routeTree';
import { Filter, FilterBar, SearchInput } from './blocks';
import { ago, plural } from './format';
import { EmptyState, Facts, PageHeader, Section } from './page';
import { StatusBadge } from './status';
import { toast } from './ui';
import { formatDateTime, useViewerTimezone } from './viewerTime';

/**
 * The settings of a project — участники, источники задач, уведомления, сам проект — and the
 * installation-wide notification defaults, which is the same editor pointed at another scope.
 *
 * One file because the four sections are one address (`…/settings/:section`) and because two of
 * them would otherwise duplicate each other's wording: a project's notification rules and the
 * installation's defaults are the same three-level resolution seen from two rungs, and a screen
 * that spelled «наследуется» differently in the two places would make the chain unreadable.
 *
 * Three things here are load-bearing and easy to lose:
 *
 * * **Роль человека и роль агента — разные вещи**, and this is the screen where the word collides.
 *   People get panel groups; an agent's role is a prompt and a model, shown here read-only with a
 *   link to the pipelines, never edited twice.
 * * **Секрет — это поле ввода, а не значение.** Everything that carries one (the project's token,
 *   a task source's credentials) arrives masked and a submitted mask means «оставить как было»
 *   (`lib/secrets.ts`). No value ever comes back from the server.
 * * **Окружение перебивает сохранённую политику уведомлений целиком**, so the editor says so
 *   instead of silently accepting a write that will not apply — a setting a person edits and that
 *   does not act is worse than one they cannot edit.
 */

const PREFIX: string = (window as any).routePrefix ?? '/dashboard';
const axios = (window as any).axios;

const MEMBERS_API = `${PREFIX}/agentiz-members`;
const TASKS_API = `${PREFIX}/agentiz-tasks`;
const NOTIFY_API = `${PREFIX}/agentiz-notifications`;
const PROJECT_API = `${PREFIX}/agentiz`;

/** What `lib/secrets.ts` sends in place of a stored secret, and what means «не менять» on the way back. */
const SECRET_MASK = '********';

/** Radix refuses an empty item value, so «наследуется» needs a sentinel of its own. */
const INHERIT = '__inherit__';

// ---------------------------------------------------------------------------------------------
// Wire shapes — what `lib/panel/settingsPanel.ts` and the notification service send
// ---------------------------------------------------------------------------------------------

export interface PanelPerson {
  id: number;
  login: string | null;
  fullName: string | null;
  email: string | null;
  avatar: string | null;
}

export interface PanelMemberRow {
  id: string;
  userId: number;
  user: PanelPerson | null;
  groupId: number;
  groupName: string | null;
  presetKey: string | null;
  tokens: string[];
  grantedBy: PanelPerson | null;
  createdAt: string;
  isOwner: boolean;
}

export interface PanelMembersView {
  items: PanelMemberRow[];
  meta: {
    canManage: boolean;
    owner: PanelPerson | null;
    ownerRoleName: string;
    presets: Array<{ key: string; name: string; description: string }>;
    roles: Array<{ id: number; name: string; description: string | null; presetKey: string | null }>;
  };
}

export interface PanelAgentRole {
  id: string;
  key: string;
  title: string;
  model: string | null;
  provider: string | null;
}

export interface PanelTaskSource {
  id: string;
  projectId: string;
  name: string;
  type: string;
  typeTitle?: string;
  isActive: boolean;
  syncComments?: boolean;
  available?: boolean;
  lastSyncedAt?: string | null;
  lastError?: string | null;
}

export interface PanelTaskManager {
  type: string;
  title: string;
  description: string | null;
  supportsWriteback: boolean;
  supportsComments: boolean;
  configFields: Array<{ key: string; title: string; kind: 'text' | 'secret'; required?: boolean; placeholder?: string; hint?: string }>;
}

type PushMode = 'on' | 'silent' | 'off';
type DashboardMode = 'on' | 'off';

export interface PolicyScopeView {
  scope: 'defaults' | 'project' | 'pipeline';
  id?: string;
  mute: boolean;
  types: Array<{
    type: string;
    kind: string;
    label: string;
    own: { push?: PushMode; dashboard?: DashboardMode };
    effective: { push: PushMode; dashboard: DashboardMode };
    inherited: { push: PushMode; dashboard: DashboardMode };
  }>;
  source: 'environment' | 'settings' | 'unset';
  shadowedByEnvironment: boolean;
  warnings: string[];
}

export interface PolicyOverride {
  scope: 'defaults' | 'project' | 'pipeline';
  id?: string;
  name: string;
  projectId?: string;
  projectName?: string;
  mute: boolean;
  types: string[];
}

export interface PanelGeneralView {
  project: Record<string, any>;
  owner: PanelPerson | null;
  hasDirectRepository: boolean;
  hasToken: boolean;
}

/** Everything `dataFor()` sends for `…/settings/:section`; only the section's own half is filled. */
export interface ProjectSettingsData {
  section: string;
  canConfigure: boolean;
  members?: PanelMembersView;
  agentRoles?: PanelAgentRole[];
  sources?: PanelTaskSource[];
  managers?: PanelTaskManager[];
  policy?: PolicyScopeView;
  general?: PanelGeneralView;
}

// ---------------------------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------------------------

const personName = (person: PanelPerson | null): string =>
  person?.fullName || person?.login || (person ? `#${person.id}` : '—');

/** Every write on these screens: one POST, one toast, one reload through the reader that painted it. */
function useWriter(reload: () => Promise<void>) {
  const [busy, setBusy] = React.useState(false);
  const post = React.useCallback(async (url: string, body: Record<string, unknown>, success?: string) => {
    setBusy(true);
    try {
      const response = await axios.post(url, body);
      if (success) toast.success(success);
      await reload();
      return response.data?.data ?? null;
    } catch (error: any) {
      toast.error(error?.response?.data?.message ?? 'Запрос не удался');
      return null;
    } finally {
      setBusy(false);
    }
  }, [reload]);
  return { busy, post };
}

// ---------------------------------------------------------------------------------------------
// Участники
// ---------------------------------------------------------------------------------------------

/** The rung of the ladder a group is, or the honest «не совпало ни с одной». */
function roleLabel(
  presets: Array<{ key: string; name: string }>,
  presetKey: string | null,
  groupName: string | null,
): string {
  const preset = presets.find((item) => item.key === presetKey);
  if (preset) return preset.name;
  return groupName ? `${groupName} · Особая роль` : 'Особая роль';
}

function InvitePanel({
  projectId,
  roles,
  presets,
  busy,
  onAdd,
  onClose,
}: {
  projectId: string;
  roles: PanelMembersView['meta']['roles'];
  presets: PanelMembersView['meta']['presets'];
  busy: boolean;
  onAdd: (userId: number, groupId: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = React.useState('');
  const [candidates, setCandidates] = React.useState<PanelPerson[] | null>(null);
  const [picked, setPicked] = React.useState<number | null>(null);
  const [groupId, setGroupId] = React.useState<string>('');

  const search = async () => {
    try {
      const response = await axios.get(MEMBERS_API, { params: { _method: 'candidates', projectId, q: query } });
      setCandidates(response.data?.data ?? []);
    } catch (error: any) {
      toast.error(error?.response?.data?.message ?? 'Поиск не удался');
    }
  };

  return (
    <div className="rounded-lg border p-3">
      <FilterBar>
        <SearchInput value={query} onChange={setQuery} placeholder="Логин, имя или почта" className="w-72" />
        <Button variant="outline" size="sm" onClick={() => { void search(); }}>Найти</Button>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onClose}>Отмена</Button>
      </FilterBar>

      {candidates === null && (
        <p className="text-xs text-muted-foreground">
          В проект добавляется тот, у кого уже есть учётная запись в панели: приглашений по почте здесь нет.
        </p>
      )}
      {candidates !== null && candidates.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Такого пользователя нет — заведите его в разделе пользователей панели.
        </p>
      )}
      {candidates !== null && candidates.length > 0 && (
        <>
          <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border">
            {candidates.map((person) => {
              const chosen = picked === person.id;
              return (
                <li key={person.id}>
                  <button
                    type="button"
                    onClick={() => setPicked(person.id)}
                    className={chosen ? 'flex w-full items-center gap-2 bg-accent px-3 py-2 text-left' : 'flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50'}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{personName(person)}</span>
                    <span className="truncate text-xs text-muted-foreground">{person.email ?? person.login ?? ''}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Select value={groupId} onValueChange={setGroupId}>
              <SelectTrigger size="sm" className="w-72"><SelectValue placeholder="Роль в проекте" /></SelectTrigger>
              <SelectContent>
                {roles.map((role) => (
                  <SelectItem key={role.id} value={String(role.id)}>
                    {roleLabel(presets, role.presetKey, role.name)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={busy || picked === null || !groupId}
              onClick={() => { if (picked !== null && groupId) onAdd(picked, Number(groupId)); }}
            >
              Добавить
            </Button>
          </div>
          {roles.length === 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Ни одной группы-роли не найдено. Роли заводятся один раз в разделе групп панели и после этого
              доступны всем проектам.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function MembersSection({
  projectId,
  slug,
  initial,
  agentRoles,
}: {
  projectId: string;
  slug: string;
  initial: PanelMembersView;
  agentRoles: PanelAgentRole[];
}) {
  const [view, setView] = React.useState<PanelMembersView>(initial);
  const [inviting, setInviting] = React.useState(false);

  const reload = React.useCallback(async () => {
    const response = await axios.get(MEMBERS_API, { params: { _method: 'list', projectId } });
    setView({ items: response.data?.data ?? [], meta: response.data?.meta ?? view.meta });
  }, [projectId, view.meta]);

  const { busy, post } = useWriter(reload);
  const { canManage, presets, roles } = view.meta;

  return (
    <div className="space-y-8">
      <Section
        title="Люди и роли"
        description="Роль — лестница: каждая ступень содержит предыдущую целиком. Владелец проекта тоже строка участника — без неё проект не виден ему самому."
        footer={canManage && !inviting ? (
          <Button variant="outline" size="sm" onClick={() => setInviting(true)}><Plus /> Добавить участника</Button>
        ) : undefined}
      >
        {view.items.length === 0 ? (
          <EmptyState
            title="Участников нет"
            description="Даже владельцу нужна строка членства: граф доступа читает её, а не `ownerId`."
          />
        ) : (
          <ul className="divide-y rounded-lg border">
            {view.items.map((member) => {
              const editable = canManage && !member.isOwner;
              const semantic = member.tokens.filter((token) => token.startsWith('agentiz-'));
              return (
                <li key={member.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{personName(member.user)}</span>
                      {member.isOwner && <Badge variant="outline">владелец</Badge>}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {member.user?.email ?? member.user?.login ?? ''}
                    </div>
                  </div>
                  <span className="w-48 shrink-0 truncate text-xs text-muted-foreground max-lg:hidden" title={semantic.join(' · ')}>
                    {semantic.length > 0 ? semantic.map((token) => token.replace('agentiz-', '')).join(', ') : '—'}
                  </span>
                  {editable ? (
                    <Filter
                      value={String(member.groupId)}
                      onChange={(value) => void post(MEMBERS_API, { _method: 'setRole', memberId: member.id, groupId: Number(value) }, 'Роль изменена')}
                      options={roles.map((role) => ({ value: String(role.id), label: roleLabel(presets, role.presetKey, role.name) }))}
                      className="w-56"
                    />
                  ) : (
                    <span className="w-56 shrink-0 truncate text-sm">{roleLabel(presets, member.presetKey, member.groupName)}</span>
                  )}
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || member.isOwner}
                      title={member.isOwner ? 'Владельца убрать нельзя: без строки членства проект перестанет быть виден ему самому' : undefined}
                      onClick={() => { void post(MEMBERS_API, { _method: 'removeMember', memberId: member.id }, 'Участник убран'); }}
                    >
                      Убрать
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {inviting && canManage && (
          <InvitePanel
            projectId={projectId}
            roles={roles}
            presets={presets}
            busy={busy}
            onClose={() => setInviting(false)}
            onAdd={(userId, groupId) => {
              void post(MEMBERS_API, { _method: 'addMember', projectId, userId, groupId }, 'Участник добавлен')
                .then(() => setInviting(false));
            }}
          />
        )}

        {!canManage && (
          <p className="text-xs text-muted-foreground">
            Состав участников виден, но менять его может тот, у кого есть право «Проект: участники» — в лестнице
            ролей оно появляется у мейнтейнера.
          </p>
        )}
      </Section>

      <Separator />

      <Section
        title="Роли агентов"
        description="Отдельная вещь от людей: это то, кем в проекте бывает агент. Промпт и модель правятся вместе с пайплайнами."
        footer={<Button asChild variant="outline" size="sm"><a href={href('project.pipelines', { slug })}>Открыть пайплайны</a></Button>}
      >
        {agentRoles.length === 0 ? (
          <p className="text-sm text-muted-foreground">Ролей агентов в проекте пока нет.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {agentRoles.map((role) => (
              <li key={role.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <code className="w-40 shrink-0 truncate text-xs text-muted-foreground">{role.key}</code>
                <span className="min-w-0 flex-1 truncate text-sm">{role.title}</span>
                <span className="w-24 shrink-0 truncate text-xs text-muted-foreground">{role.provider ?? '—'}</span>
                <span className="w-48 shrink-0 truncate font-mono text-xs text-muted-foreground">{role.model ?? 'по умолчанию'}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Источники задач
// ---------------------------------------------------------------------------------------------

function NewSourceForm({
  projectId,
  managers,
  busy,
  onCreate,
  onClose,
}: {
  projectId: string;
  managers: PanelTaskManager[];
  busy: boolean;
  onCreate: (body: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const [type, setType] = React.useState('');
  const [name, setName] = React.useState('');
  const [values, setValues] = React.useState<Record<string, string>>({});
  const manager = managers.find((item) => item.type === type) ?? null;

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={type} onValueChange={(value: string) => { setType(value); setValues({}); }}>
          <SelectTrigger size="sm" className="w-56"><SelectValue placeholder="Таск-менеджер" /></SelectTrigger>
          <SelectContent>
            {managers.map((item) => <SelectItem key={item.type} value={item.type}>{item.title}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input
          value={name}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value)}
          placeholder="Название источника"
          className="h-8 w-64"
        />
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onClose}>Отмена</Button>
      </div>

      {managers.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Ни один слой интеграции не смонтирован — подключать нечего. Типы приходят из коллекции
          <code className="mx-1">taskManagers</code>.
        </p>
      )}

      {manager && (
        <>
          {manager.description && <p className="text-xs text-muted-foreground">{manager.description}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            {manager.configFields.map((field) => (
              <label key={field.key} className="text-xs">
                <span className="block text-muted-foreground">
                  {field.title}{field.required ? ' *' : ''}
                </span>
                <Input
                  type={field.kind === 'secret' ? 'password' : 'text'}
                  value={values[field.key] ?? ''}
                  placeholder={field.placeholder}
                  className="mt-1 h-8"
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                    setValues((current) => ({ ...current, [field.key]: event.target.value }))}
                />
                {field.hint && <span className="text-muted-foreground">{field.hint}</span>}
              </label>
            ))}
          </div>
        </>
      )}

      <Button
        size="sm"
        disabled={busy || !type || !name.trim()}
        onClick={() => onCreate({ _method: 'createSource', projectId, type, name: name.trim(), values, isActive: true })}
      >
        Добавить источник
      </Button>
    </div>
  );
}

function SourcesSection({
  projectId,
  initial,
  managers,
  canConfigure,
}: {
  projectId: string;
  initial: PanelTaskSource[];
  managers: PanelTaskManager[];
  canConfigure: boolean;
}) {
  const [sources, setSources] = React.useState<PanelTaskSource[]>(initial);
  const [adding, setAdding] = React.useState(false);

  const reload = React.useCallback(async () => {
    const response = await axios.get(TASKS_API, { params: { _method: 'getSources', projectId } });
    setSources(response.data?.data ?? []);
  }, [projectId]);

  const { busy, post } = useWriter(reload);

  return (
    <Section
      title="Откуда приходят задачи"
      description="Каждый источник — один удалённый таск-менеджер. Раньше это жило прямо на экране задач и делало доску настройкой проекта."
      footer={canConfigure && !adding ? (
        <Button variant="outline" size="sm" onClick={() => setAdding(true)}><Plus /> Добавить источник</Button>
      ) : undefined}
    >
      {sources.length === 0 ? (
        <EmptyState
          title="Источников нет"
          description="Задачи можно заводить прямо в панели — внешний трекер нужен только чтобы зеркалить чужие."
        />
      ) : (
        <ul className="divide-y rounded-lg border">
          {sources.map((source) => (
            <li key={source.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">{source.name}</span>
                    <Badge variant="outline">{source.typeTitle ?? source.type}</Badge>
                    {source.available === false && (
                      <Badge variant="outline" className="border-transparent bg-destructive/15 text-destructive">
                        слой адаптера не смонтирован
                      </Badge>
                    )}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {source.lastSyncedAt ? `Синхронизация ${ago(source.lastSyncedAt)} назад` : 'Ещё ни разу не синхронизировался'}
                  </div>
                </div>
                <StatusBadge status={source.isActive ? 'active' : 'inactive'} className="w-28 shrink-0 justify-center" />
                {canConfigure && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => { void post(TASKS_API, { _method: 'syncSource', sourceId: source.id }, 'Синхронизация выполнена'); }}
                    >
                      Синхронизировать
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={async () => {
                        const result = await post(TASKS_API, { _method: 'testSource', sourceId: source.id });
                        if (result) toast.success(result.ok ? 'Подключение работает' : 'Подключение не удалось');
                      }}
                    >
                      Проверить
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        void post(
                          TASKS_API,
                          { _method: 'updateSource', sourceId: source.id, isActive: !source.isActive },
                          source.isActive ? 'Источник выключен' : 'Источник включён',
                        );
                      }}
                    >
                      {source.isActive ? 'Выключить' : 'Включить'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`Удалить источник «${source.name}»? Уже загруженные задачи останутся.`)) return;
                        void post(TASKS_API, { _method: 'deleteSource', sourceId: source.id }, 'Источник удалён');
                      }}
                    >
                      Удалить
                    </Button>
                  </div>
                )}
              </div>

              {source.lastError && <p className="mt-1 text-xs text-destructive">{source.lastError}</p>}

              {canConfigure && (
                <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  {/* Off by default: one extra API call per task the sync touched. */}
                  <Switch
                    checked={Boolean(source.syncComments)}
                    disabled={busy}
                    onCheckedChange={(value: boolean) => {
                      void post(
                        TASKS_API,
                        { _method: 'updateSource', sourceId: source.id, syncComments: value },
                        'Настройка сохранена',
                      );
                    }}
                  />
                  Тянуть обсуждение при синхронизации
                </label>
              )}
            </li>
          ))}
        </ul>
      )}

      {adding && canConfigure && (
        <NewSourceForm
          projectId={projectId}
          managers={managers}
          busy={busy}
          onClose={() => setAdding(false)}
          onCreate={(body) => { void post(TASKS_API, body, 'Источник добавлен').then(() => setAdding(false)); }}
        />
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Уведомления
// ---------------------------------------------------------------------------------------------

const PUSH_LABELS: Record<PushMode, string> = { on: 'будить', silent: 'тихо', off: 'не слать' };
const DASHBOARD_LABELS: Record<DashboardMode, string> = { on: 'слать', off: 'не слать' };

/**
 * The editor of one scope of `AGENTIZ_NOTIFY_POLICY`.
 *
 * The same component for all three scopes on purpose: `defaults`, a project and a pipeline differ
 * only in what they inherit from, and the chain (пайплайн → проект → по умолчанию → встроенное) is
 * invisible unless every editor shows it the same way. Hence the third value of every select —
 * «наследуется», meaning this scope stores nothing and the level below decides.
 *
 * `effective`/`inherited` come from the server (`describeScope`), so the hint beside a select is
 * the real resolution result and not a guess made in the browser.
 */
export function NotificationScopeEditor({
  scope,
  id,
  canEdit,
  initial,
  inheritsFrom,
  onSaved,
}: {
  scope: 'defaults' | 'project' | 'pipeline';
  id?: string;
  canEdit: boolean;
  initial: PolicyScopeView;
  inheritsFrom: string;
  onSaved?: () => void;
}) {
  const [view, setView] = React.useState<PolicyScopeView>(initial);
  const [draft, setDraft] = React.useState<Record<string, { push?: PushMode; dashboard?: DashboardMode }>>(
    () => Object.fromEntries(initial.types.map((row) => [row.type, { ...row.own }])),
  );
  const [mute, setMute] = React.useState(initial.mute);
  const [busy, setBusy] = React.useState(false);

  const adopt = React.useCallback((data: PolicyScopeView) => {
    setView(data);
    setDraft(Object.fromEntries(data.types.map((row) => [row.type, { ...row.own }])));
    setMute(data.mute);
  }, []);

  const dirty = mute !== view.mute || view.types.some((row) => {
    const current = draft[row.type] ?? {};
    return current.push !== row.own.push || current.dashboard !== row.own.dashboard;
  });

  const save = React.useCallback(async (entry: Record<string, unknown> | null) => {
    setBusy(true);
    try {
      const response = await axios.post(NOTIFY_API, { _method: 'setScope', scope, id, entry });
      adopt(response.data?.data);
      toast.success('Правила доставки сохранены');
      onSaved?.();
    } catch (error: any) {
      toast.error(error?.response?.data?.message ?? 'Не удалось сохранить правила');
    } finally {
      setBusy(false);
    }
  }, [scope, id, adopt, onSaved]);

  const saveDraft = () => {
    const entry: Record<string, unknown> = {};
    if (mute) entry.mute = true;
    for (const [type, value] of Object.entries(draft)) {
      const cleaned: Record<string, string> = {};
      if (value.push) cleaned.push = value.push;
      if (value.dashboard) cleaned.dashboard = value.dashboard;
      if (Object.keys(cleaned).length > 0) entry[type] = cleaned;
    }
    // An empty entry is not «всё выключено» — it is «эта область ничего не говорит», so remove it.
    void save(Object.keys(entry).length > 0 ? entry : null);
  };

  const setChannel = (type: string, channel: 'push' | 'dashboard', value: string) => {
    setDraft((current) => {
      const entry: Record<string, any> = { ...(current[type] ?? {}) };
      if (value === INHERIT) delete entry[channel];
      else entry[channel] = value;
      return { ...current, [type]: entry };
    });
  };

  /** Which level this scope inherits from, and where the value comes from at all. */
  const sourceNote = view.source === 'environment'
    ? 'Значение берётся из переменной окружения AGENTIZ_NOTIFY_POLICY'
    : view.source === 'settings'
      ? 'Значение хранится в настройках установки'
      : 'Нигде не задано — действуют встроенные значения';

  return (
    <div className="space-y-4">
      {view.shadowedByEnvironment && (
        <div className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm">
          <p className="font-medium">Настройка перекрыта окружением</p>
          <p className="mt-1 text-muted-foreground">
            `AGENTIZ_NOTIFY_POLICY` задана в `.env` и перекрывает сохранённый документ целиком — правки отсюда
            сохранятся, но применяться будет значение из окружения. Уберите переменную, чтобы настройки панели заработали.
          </p>
        </div>
      )}

      <Section
        title="Что доставлять"
        description={
          <>
            Лента событий пишется всегда — настройка решает только, будить ли человека. Область разрешается от
            частного к общему: пайплайн → проект → по умолчанию → встроенное. Что здесь не задано, берётся {inheritsFrom}.
            <span className="mt-1 block text-xs">{sourceNote}.</span>
          </>
        }
      >
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={mute} disabled={!canEdit || busy} onCheckedChange={setMute} />
          Замьютить всё
          <span className="text-xs text-muted-foreground">(кроме типов, у которых ниже выбрано явное значение)</span>
        </label>

        {/*
          * Подписи каналов — шапка списка, а не подпись у каждого селекта.
          *
          * Замерено: в узкой колонке настроек строке достаётся 664 px, а «Пуш» + селект +
          * «Колокольчик» + селект съедали 567 из них. Названию оставалось около сорока, и от
          * «Агент задал вопрос» на экране было «А…» — двадцать шесть строк, в которых нельзя
          * прочитать ни одного события. Два слова, вынесенные наверх, отдают эти 127 px названию,
          * а селекты заодно становятся шире текста «как выше: не слать» (131 px), который до этого
          * обрезался в каждой строке.
          */}
        <ul className="divide-y rounded-lg border">
          <li className="flex items-center gap-3 px-4 py-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1">Событие</span>
            <span className="w-48 shrink-0">Пуш</span>
            <span className="w-48 shrink-0">Колокольчик</span>
          </li>
          {view.types.map((row) => {
            const entry = draft[row.type] ?? {};
            return (
              <li key={row.type} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <div className="min-w-48 flex-1">
                  <div className="truncate text-sm">{row.label}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    <span className="font-mono">{row.type}</span>
                    <span className="max-md:hidden">
                      {' · сейчас: '}{PUSH_LABELS[row.effective.push]} · {DASHBOARD_LABELS[row.effective.dashboard]}
                    </span>
                  </div>
                </div>
                <Filter
                  value={entry.push ?? INHERIT}
                  onChange={(value) => setChannel(row.type, 'push', value)}
                  disabled={!canEdit || busy}
                  aria-label={`Пуш: ${row.label}`}
                  options={[
                    { value: INHERIT, label: `как выше: ${PUSH_LABELS[row.inherited.push]}` },
                    { value: 'on', label: 'будить' },
                    { value: 'silent', label: 'тихо' },
                    { value: 'off', label: 'не слать' },
                  ]}
                  className="w-48 shrink-0"
                />
                <Filter
                  value={entry.dashboard ?? INHERIT}
                  onChange={(value) => setChannel(row.type, 'dashboard', value)}
                  disabled={!canEdit || busy}
                  aria-label={`Колокольчик: ${row.label}`}
                  options={[
                    { value: INHERIT, label: `как выше: ${DASHBOARD_LABELS[row.inherited.dashboard]}` },
                    { value: 'on', label: 'слать' },
                    { value: 'off', label: 'не слать' },
                  ]}
                  className="w-48 shrink-0"
                />
              </li>
            );
          })}
        </ul>

        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy || !dirty} onClick={saveDraft}>Сохранить</Button>
            <Button variant="outline" size="sm" disabled={busy || !dirty} onClick={() => adopt(view)}>Отменить правки</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void save(null); }}>Вернуть к наследуемым</Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Правила видны, но менять их может тот, у кого есть право настраивать этот уровень.
          </p>
        )}
      </Section>
    </div>
  );
}

/**
 * The same editor for a screen whose server payload does not carry the scope.
 *
 * Two of the three scopes are painted by `dataFor()` — a project's «Уведомления» and the
 * installation defaults are what their address is about — while the third is one tab of the
 * pipeline editor, and shipping every event type's resolution inside the pipeline board's props
 * would cost that on every pipeline screen, opened tab or not. So this one reads it when the tab
 * is shown, and hands it to the editor above rather than being a second editor: the resolution
 * chain has to be worded identically wherever it is seen, which is the whole reason that editor
 * is one component for three scopes.
 */
export function NotificationScopePanel({
  scope,
  id,
  canEdit,
  inheritsFrom,
}: {
  scope: 'defaults' | 'project' | 'pipeline';
  id?: string;
  canEdit: boolean;
  inheritsFrom: string;
}) {
  const [view, setView] = React.useState<PolicyScopeView | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setView(null);
    setError(null);
    axios
      .get(NOTIFY_API, { params: { _method: 'getScope', scope, id } })
      .then((response: any) => { if (!cancelled) setView(response.data?.data ?? null); })
      .catch((failure: any) => {
        if (!cancelled) setError(failure?.response?.data?.message ?? 'Не удалось загрузить правила доставки');
      });
    return () => { cancelled = true; };
  }, [scope, id]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!view) return <p className="text-sm text-muted-foreground">Загрузка…</p>;
  // Keyed by the scope: the editor seeds its draft from `initial` once, so switching to another
  // pipeline has to give it a new instance rather than a new prop it will not read.
  return (
    <NotificationScopeEditor
      key={`${scope}:${id ?? ''}`}
      scope={scope}
      id={id}
      canEdit={canEdit}
      initial={view}
      inheritsFrom={inheritsFrom}
    />
  );
}

const OVERRIDE_SCOPE_TITLES: Record<PolicyOverride['scope'], string> = {
  defaults: 'общие',
  project: 'проект',
  pipeline: 'пайплайн',
};

/**
 * «Уведомления» уровня установки: the `defaults` scope plus every place that overrides it.
 *
 * The list is the reason this screen exists. Overrides are made where the thing lives (a project's
 * settings, a pipeline editor), so without one screen that walks the document, an override made
 * months ago is unfindable and the silence it causes has no visible reason. A row links back to
 * the screen that owns it rather than editing in place — one editor per scope, no second truth.
 */
export function GlobalNotificationsScreen({
  policy,
  overrides,
  canEdit,
  projectSlugs,
}: {
  policy: PolicyScopeView;
  overrides: PolicyOverride[];
  canEdit: boolean;
  projectSlugs: Record<string, string>;
}) {
  const [rows, setRows] = React.useState<PolicyOverride[]>(overrides);

  const reload = React.useCallback(async () => {
    try {
      const response = await axios.get(NOTIFY_API, { params: { _method: 'getOverrides' } });
      setRows(response.data?.data ?? []);
    } catch {
      // The list is a pointer, not the editor: failing to refresh it must not look like a failed save.
    }
  }, []);

  const linkTo = (override: PolicyOverride): string | null => {
    const slug = override.scope === 'project'
      ? projectSlugs[override.id ?? '']
      : projectSlugs[override.projectId ?? ''];
    if (!slug) return null;
    if (override.scope === 'project') return href('project.settings', { slug, section: 'notifications' });
    if (override.scope === 'pipeline' && override.id) return href('project.pipeline', { slug, specId: override.id });
    return null;
  };

  return (
    <>
      <PageHeader
        title="Уведомления"
        description="Значения по умолчанию для всех проектов. Проект и пайплайн могут их переопределить."
      />

      <div className="space-y-8">
        <NotificationScopeEditor
          scope="defaults"
          canEdit={canEdit}
          initial={policy}
          inheritsFrom="из встроенных значений"
          onSaved={() => void reload()}
        />

        <Separator />

        <Section
          title="Где переопределено"
          description="Проекты и пайплайны со своими правилами. Правится там же, где живёт сама сущность."
        >
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Нигде — всё работает по правилам выше.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {rows.map((override) => {
                const link = linkTo(override);
                return (
                  <li key={`${override.scope}:${override.id ?? 'defaults'}`} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                    <Badge variant="outline" className="shrink-0">{OVERRIDE_SCOPE_TITLES[override.scope]}</Badge>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{override.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {override.projectName ? `${override.projectName} · ` : ''}
                        {override.types.length > 0
                          ? `${override.types.length} ${plural(override.types.length, 'правило', 'правила', 'правил')}: ${override.types.join(', ')}`
                          : 'без правил по типам'}
                      </div>
                    </div>
                    {override.mute && (
                      <Badge variant="outline" className="border-transparent bg-destructive/15 text-destructive">замьючено</Badge>
                    )}
                    {link && <Button asChild variant="outline" size="sm"><a href={link}>Настроить</a></Button>}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Настройки проекта
// ---------------------------------------------------------------------------------------------

function GeneralSection({
  projectId,
  slug,
  initial,
  canConfigure,
}: {
  projectId: string;
  slug: string;
  initial: PanelGeneralView;
  canConfigure: boolean;
}) {
  const [view, setView] = React.useState<PanelGeneralView>(initial);
  const [token, setToken] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const project = view.project;

  const call = async (body: Record<string, unknown>, success: string) => {
    setBusy(true);
    try {
      const response = await axios.post(PROJECT_API, body);
      toast.success(success);
      return response.data?.data ?? null;
    } catch (error: any) {
      toast.error(error?.response?.data?.message ?? 'Запрос не удался');
      return null;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <Section
        title="Проект"
        description="Название, слаг и описание правятся в карточке модели — там же, где они и заводились."
        footer={(
          <>
            <Button asChild variant="outline" size="sm">
              <a href={`${PREFIX}/model/AgentProject/edit/${projectId}`}>Открыть карточку проекта</a>
            </Button>
            {canConfigure && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => { void call({ _method: 'syncProject', projectId }, 'Синхронизация выполнена'); }}
              >
                Синхронизировать
              </Button>
            )}
          </>
        )}
      >
        <Facts
          items={[
            ['Название', project.name],
            ['Слаг', <code key="slug" className="text-xs">{project.slug}</code>],
            ['Состояние', <StatusBadge key="state" status={project.isActive === false ? 'inactive' : 'active'} />],
            ['Владелец', view.owner ? personName(view.owner) : 'не назначен'],
            ['Заведён', project.createdAt ? formatDateTime(project.createdAt) : '—'],
            ['Последняя синхронизация', project.lastSyncedAt ? `${ago(project.lastSyncedAt)} назад` : 'никогда'],
          ]}
        />
        {project.description && <p className="text-sm text-muted-foreground">{project.description}</p>}
        {!view.owner && (
          <p className="text-xs text-muted-foreground">
            У проекта без владельца нет строки членства, которую пишет `@AfterCreate` — назначьте владельца в
            карточке, и она появится.
          </p>
        )}
      </Section>

      <Separator />

      <Section
        title="Прямое подключение к репозиторию"
        description="Ранний способ связать проект с репозиторием — до того, как появились git-подключения. Учётные записи, OAuth-приложения и зеркала живут в разделе интеграций, а привязки — в «Репозиториях» проекта."
        footer={(
          <Button asChild variant="outline" size="sm">
            <a href={href('project.repositories', { slug })}>Репозитории проекта</a>
          </Button>
        )}
      >
        {view.hasDirectRepository ? (
          <>
            <Facts
              items={[
                ['Платформа', String(project.repoProvider ?? '—')],
                ['Репозиторий', `${project.repoConfig?.owner ?? '?'}/${project.repoConfig?.repo ?? '?'}`],
                ['Ветка по умолчанию', String(project.repoConfig?.defaultBranch ?? 'по умолчанию')],
                ['Токен', view.hasToken ? 'сохранён' : 'не задан'],
              ]}
            />
            {canConfigure && (
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs">
                  <span className="block text-muted-foreground">Новый токен доступа</span>
                  <Input
                    type="password"
                    value={token}
                    placeholder={view.hasToken ? SECRET_MASK : 'не задан'}
                    className="mt-1 h-8 w-72"
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => setToken(event.target.value)}
                  />
                </label>
                <Button
                  size="sm"
                  disabled={busy || token.trim().length === 0}
                  onClick={async () => {
                    // The value goes one way only: what comes back is the mask, and sending the
                    // mask back is how «оставить как было» is spelled (`lib/secrets.ts`).
                    const saved = await call(
                      { _method: 'updateProjectSecrets', projectId, secrets: { token: token.trim() } },
                      'Токен сохранён',
                    );
                    if (saved) {
                      setToken('');
                      setView((current) => ({ ...current, project: saved, hasToken: true }));
                    }
                  }}
                >
                  Сохранить токен
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={async () => {
                    const result = await call({ _method: 'testConnection', projectId }, 'Проверка выполнена');
                    if (result) toast.success(result.ok ? 'Подключение работает' : 'Подключение не удалось');
                  }}
                >
                  Проверить подключение
                </Button>
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Не используется: проект работает через git-подключения. Так и надо — прямое подключение оставлено только
            для проектов, заведённых до них.
          </p>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------------------------

export function ProjectSettingsScreen({
  data,
  project,
}: {
  data: ProjectSettingsData;
  project: { id: string; slug: string; name: string };
}) {
  useViewerTimezone();
  // The sidebar and the breadcrumb print the same words, from the same table (`routeTree.ts`).
  const title = PROJECT_SETTINGS_TITLES[data.section as ProjectSettingsSection] ?? 'Настройки';

  const body = (() => {
    if (data.section === 'members' && data.members) {
      return (
        <MembersSection
          projectId={project.id}
          slug={project.slug}
          initial={data.members}
          agentRoles={data.agentRoles ?? []}
        />
      );
    }
    if (data.section === 'sources' && data.sources) {
      return (
        <SourcesSection
          projectId={project.id}
          initial={data.sources}
          managers={data.managers ?? []}
          canConfigure={data.canConfigure}
        />
      );
    }
    if (data.section === 'notifications' && data.policy) {
      return (
        <NotificationScopeEditor
          scope="project"
          id={project.id}
          canEdit={data.canConfigure}
          initial={data.policy}
          inheritsFrom="из общих настроек"
        />
      );
    }
    if (data.section === 'general' && data.general) {
      return (
        <GeneralSection
          projectId={project.id}
          slug={project.slug}
          initial={data.general}
          canConfigure={data.canConfigure}
        />
      );
    }
    // `dataFor` normalises an unknown section to the first one, so this is the other case: the
    // section's own data did not come. Saying which one is what makes that debuggable at all.
    return (
      <EmptyState
        title="Раздел не открылся"
        description={`Сервер не прислал данные раздела «${data.section}» — обновите страницу, и если не помогло, посмотрите лог сервера.`}
      />
    );
  })();

  return (
    <>
      <PageHeader title={title} meta={<span>проект {project.name}</span>} />
      {body}
    </>
  );
}
