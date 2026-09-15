import { Op } from 'sequelize';
import { AgentActivity } from '../../models/AgentActivity';
import { AgentGitConnection } from '../../models/AgentGitConnection';
import { AgentProjectRepository } from '../../models/AgentProjectRepository';
import { AgentRepository } from '../../models/AgentRepository';
import { getGitConnectionAuthority, gitProviderTitle, listGitProviderPanels } from '../git';
import type { GitProviderPanelField } from '../git';
import { activityTypes } from '../notifications/activityTypes';
import { maskRepositoryWebhook } from '../webhooks';
import type { ProjectRepositoryConfig } from '../../types/agentiz';
import { href } from './routeTree';

/**
 * The two repository screens of the panel, resolved on the server: the repositories of one project
 * and the installation's git providers.
 *
 * It sits beside the screens rather than inside `repositoryRoutes.ts` for the reason `runBoard.ts`
 * does: `lib/panel/render.ts` renders the first paint and must not import a route table, which
 * drags in every service behind it. Both readers — the render and the `_method` endpoint the screen
 * polls — call the same function, so what the page is painted with and what it refreshes into
 * cannot drift.
 *
 * Two secrets pass close by here and neither is allowed through. `AgentGitConnection.secrets` is
 * dropped by naming the fields that travel instead of spreading the row, and `AgentRepository.webhook`
 * only ever leaves as `maskRepositoryWebhook` — the delivery secret in that column is what an
 * incoming hook's signature is checked against (AGENTS.md).
 */

/** The webhook of a repository as a screen may see it: state and reason, never the secret. */
export interface PanelRepositoryWebhook {
  /** True once a hook exists at the platform. False is a **supported state**, not a failure. */
  installed: boolean;
  url: string | null;
  installedAt: string | null;
  lastDeliveryAt: string | null;
  /** Why there is no hook (no public URL, no receiving layer, a connection with a trimmed scope). */
  lastError: string | null;
  /** The event set the hook was installed with; absent means it predates the field, i.e. is stale. */
  events: string[] | null;
}

/** Where the two observers of a repository left off. Read-only everywhere in the panel. */
export interface PanelRepositoryWatch {
  branches: Array<{ branch: string; sha: string }>;
  branchCount: number;
  lastCiRunId: number | null;
  checkedAt: string | null;
}

export interface PanelProjectRepository {
  /** Id of the **link**, which is what every write on this screen addresses. */
  id: string;
  projectId: string;
  repositoryId: string;
  provider: string;
  providerTitle: string;
  role: string;
  isPrimary: boolean;
  syncIssues: boolean;
  isActive: boolean;
  /**
   * The link's own configuration, whole rather than as the one field the screen edits:
   * `updateProjectRepository` takes `config` as a unit, so an editor that only knew
   * `defaultBranch` would erase everything else in it on the first save.
   */
  config: ProjectRepositoryConfig | null;
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
  /**
   * The last repository fact this project actually saw, out of the feed the events write into.
   *
   * `badge` is the word the type is called by everywhere else in the panel and on the phone
   * (`activityTypes.ts`); a screen inventing its own noun for «коммиты» is how three surfaces end
   * up naming one event three ways.
   */
  lastEvent: { type: string; badge: string; title: string; createdAt: string } | null;
}

export interface PanelGitConnection {
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
  /** Whether a token is stored at all — the value itself never leaves the server. */
  hasSecrets: boolean;
}

export interface PanelGitProvider {
  provider: string;
  title: string;
  summary: string;
  /** Where the layer answers `_method` requests, or null when no layer describes this platform. */
  apiRoute: string | null;
  /** The provider's own screen. */
  href: string;
  /** A layer describing this platform is mounted, so its OAuth applications can be managed. */
  described: boolean;
  /** A `GitConnectionAuthority` is mounted, so tokens can be renewed and mirrors refreshed. */
  authorityMounted: boolean;
  appFields: GitProviderPanelField[];
  appIdentityField: string;
  appHint: string;
  defaultScopes: string[];
  connections: PanelGitConnection[];
  repositoryCount: number;
}

/** The three feed types a repository produces, newest first. */
const REPOSITORY_EVENT_TYPES = ['repository.pushed', 'repository.ci_run', 'repository.package'];

/**
 * How far back the «последнее событие» column looks.
 *
 * Read out of the feed in one query and matched in **JavaScript** on `data.repositoryId`: that
 * column is JSON, and JSON filtering differs between the postgres and the sqlite deployments — the
 * same reason a queue filter has to be a real column (AGENTS.md). A repository quieter than the
 * last 200 events of its project simply shows no event, which reads correctly: the screen says
 * what it saw, not what exists.
 */
const EVENT_SCAN_LIMIT = 200;

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function webhookForUI(repository: AgentRepository | null): PanelRepositoryWebhook | null {
  if (!repository) return null;
  const masked = maskRepositoryWebhook(repository) as Record<string, any> | null;
  if (!masked) return null;
  return {
    installed: Boolean(masked.hookId),
    url: masked.url ?? null,
    installedAt: iso(masked.installedAt),
    lastDeliveryAt: iso(masked.lastDeliveryAt),
    lastError: masked.lastError ?? null,
    events: Array.isArray(masked.events) ? masked.events : null,
  };
}

function watchForUI(repository: AgentRepository | null): PanelRepositoryWatch | null {
  const cursor = repository?.watchCursor;
  if (!cursor) return null;
  const heads = Object.entries(cursor.branchHeads ?? {});
  return {
    // Enough to recognise where the watcher is, not a branch list: a repository with 200 branches
    // would otherwise put 200 rows into a page prop nobody reads.
    branches: heads.slice(0, 3).map(([branch, sha]) => ({ branch, sha })),
    branchCount: heads.length,
    lastCiRunId: cursor.lastCiRunId ?? null,
    checkedAt: iso(cursor.checkedAt),
  };
}

/**
 * The last repository event each (project, repository) pair saw.
 *
 * Keyed by both because the fact is about a repository while the feed row is about a project: one
 * repository linked to two projects raises two events off one observation, and a project must not
 * be shown the other's.
 */
async function lastEventsByRepository(projectIds: string[]): Promise<Map<string, PanelProjectRepository['lastEvent']>> {
  const found = new Map<string, PanelProjectRepository['lastEvent']>();
  if (projectIds.length === 0) return found;
  const rows = await AgentActivity.findAll({
    where: { projectId: { [Op.in]: projectIds }, type: { [Op.in]: REPOSITORY_EVENT_TYPES } },
    order: [['createdAt', 'DESC']],
    limit: EVENT_SCAN_LIMIT,
  });
  for (const row of rows) {
    const repositoryId = (row.data as any)?.repositoryId;
    if (typeof repositoryId !== 'string') continue;
    const key = `${row.projectId}:${repositoryId}`;
    if (found.has(key)) continue;
    const badge = activityTypes().find((def) => def.type === row.type)?.badge ?? row.type;
    found.set(key, { type: row.type, badge, title: row.title, createdAt: iso(row.createdAt)! });
  }
  return found;
}

/**
 * The repositories of the given projects, with everything the screen prints about how each one is
 * watched. The caller decides the scope — one project for the project screen, `projectIdsForUser`
 * for anything global — exactly as the inbox takes its scope as an argument.
 */
export async function projectRepositoryRows(projectIds: string[]): Promise<PanelProjectRepository[]> {
  if (projectIds.length === 0) return [];
  const links = await AgentProjectRepository.findAll({
    where: { projectId: { [Op.in]: projectIds } },
    order: [['createdAt', 'ASC']],
    include: [
      { model: AgentRepository, as: 'repository' },
      { model: AgentGitConnection, as: 'connection' },
    ],
  });
  const events = await lastEventsByRepository(projectIds);

  return links.map((link) => {
    const repository = link.repository ?? null;
    const connection = link.connection ?? null;
    return {
      id: link.id,
      projectId: link.projectId,
      repositoryId: link.repositoryId,
      provider: link.provider,
      providerTitle: gitProviderTitle(link.provider),
      role: link.role,
      isPrimary: link.isPrimary,
      syncIssues: link.syncIssues,
      isActive: link.isActive,
      config: link.config ?? null,
      lastSyncedAt: iso(link.lastSyncedAt),
      lastError: link.lastError ?? null,
      repository: repository
        ? {
            id: repository.id,
            pathWithNamespace: repository.pathWithNamespace,
            name: repository.name ?? null,
            webUrl: repository.webUrl ?? null,
            cloneUrl: repository.cloneUrl ?? null,
            defaultBranch: repository.defaultBranch ?? null,
            visibility: repository.visibility ?? null,
            lastActivityAt: iso(repository.lastActivityAt),
          }
        : null,
      connection: connection
        ? {
            id: connection.id,
            username: connection.username ?? null,
            displayName: connection.displayName ?? null,
            baseUrl: connection.baseUrl ?? null,
            status: connection.status,
          }
        : null,
      webhook: webhookForUI(repository),
      watch: watchForUI(repository),
      lastEvent: repository ? events.get(`${link.projectId}:${repository.id}`) ?? null : null,
    };
  });
}

function connectionForUI(connection: AgentGitConnection, repositoryCount: number): PanelGitConnection {
  return {
    id: connection.id,
    provider: connection.provider,
    username: connection.username ?? null,
    displayName: connection.displayName ?? null,
    baseUrl: connection.baseUrl ?? null,
    status: connection.status,
    scope: connection.scope ?? null,
    expiresAt: iso(connection.expiresAt),
    lastSyncedAt: iso(connection.lastSyncedAt),
    lastError: connection.lastError ?? null,
    repositoryCount,
    hasSecrets: Boolean(connection.secrets?.accessToken),
  };
}

/**
 * Every git platform the installation has anything to say about: the ones a mounted layer
 * describes, plus the ones only a stored connection remembers.
 *
 * The second half is the point of the union. A layer can be unmounted while its connections stay in
 * the database — that is a supported state (`requireGitConnectionAuthority` says so out loud) — and
 * a screen built only from the registry would answer «нет подключений» on an installation that has
 * several. Such a platform is shown with `described: false` and no buttons rather than hidden.
 */
export async function gitProvidersOverview(): Promise<PanelGitProvider[]> {
  const [connections, repositories] = await Promise.all([
    AgentGitConnection.findAll({ order: [['createdAt', 'DESC']] }),
    AgentRepository.findAll({ attributes: ['id', 'connectionId', 'provider'] }),
  ]);

  const perConnection = new Map<string, number>();
  const perProvider = new Map<string, number>();
  for (const repository of repositories) {
    perConnection.set(repository.connectionId, (perConnection.get(repository.connectionId) ?? 0) + 1);
    perProvider.set(repository.provider, (perProvider.get(repository.provider) ?? 0) + 1);
  }

  const described = listGitProviderPanels();
  const names = [...described.map((panel) => panel.provider)];
  for (const connection of connections) if (!names.includes(connection.provider)) names.push(connection.provider);

  return names.map((provider) => {
    const panel = described.find((item) => item.provider === provider);
    const own = connections.filter((connection) => connection.provider === provider);
    return {
      provider,
      title: panel?.title ?? provider,
      summary: panel?.summary ?? 'Слой этой платформы не смонтирован: подключения видны, управлять ими нельзя.',
      apiRoute: panel?.apiRoute ?? null,
      href: href('integrations.gitProvider', { provider }),
      described: Boolean(panel),
      authorityMounted: Boolean(getGitConnectionAuthority(provider as any)),
      appFields: panel?.appFields ?? [],
      appIdentityField: panel?.appIdentityField ?? 'clientId',
      appHint: panel?.appHint ?? '',
      defaultScopes: panel?.defaultScopes ?? [],
      connections: own.map((connection) => connectionForUI(connection, perConnection.get(connection.id) ?? 0)),
      repositoryCount: perProvider.get(provider) ?? 0,
    };
  });
}

/** One platform's card, or null when neither a layer nor a connection knows that name. */
export async function gitProviderDetail(provider: string): Promise<PanelGitProvider | null> {
  return (await gitProvidersOverview()).find((item) => item.provider === provider) ?? null;
}
