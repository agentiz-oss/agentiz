import type { IMcpTool } from '@nodeknit/app-mcp';
import { AgentGitConnection } from '../models/AgentGitConnection';
import { AgentProjectRepository } from '../models/AgentProjectRepository';
import { AgentRepository } from '../models/AgentRepository';
import { getGitConnectionAuthority } from '../lib/git';
import {
  findRepositoryByPath, linkRepositoryToProject, RepositoryLinkError,
  syncConnectionRepositories, updateProjectRepositoryLink,
} from '../lib/git/projectRepositoryLinks';
import { maskConnectionForUI } from '../lib/secrets';
import { maskRepositoryWebhook } from '../lib/webhooks';
import type { ProjectRepositoryRole } from '../types/agentiz';

/**
 * Repositories over MCP: until these existed a project could be created, given roles, a pipeline,
 * a worker directory and a task over MCP — and then had to be finished in the panel, because the
 * one step "привязать репозиторий" was only a button there.
 *
 * Creating a repository on the platform is deliberately **not** here: that is an agent's job on
 * the worker (`gh repo create --source . --push`), under the identity the worker machine has.
 * What the server can do afterwards is see it — `sync` re-mirrors a connection — and link it, and
 * `link` by `pathWithNamespace` does both in one call, since `owner/name` is all anyone knows
 * right after `gh` printed it.
 */

type Params = Record<string, unknown>;

const LIMIT_DEFAULT = 100;
const LIMIT_MAX = 1000;

function objectParams(params: unknown): Params {
  return params !== null && typeof params === 'object' && !Array.isArray(params) ? params as Params : {};
}

function stringParam(params: Params, name: string): string | undefined {
  const value = params[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requiredString(params: Params, name: string): string {
  const value = stringParam(params, name);
  if (!value) throw new Error(`${name}:string is required`);
  return value;
}

function boolParam(params: Params, name: string): boolean | undefined {
  return typeof params[name] === 'boolean' ? params[name] as boolean : undefined;
}

function limitParam(params: Params): number {
  const value = typeof params.limit === 'number' ? params.limit : Number(params.limit ?? LIMIT_DEFAULT);
  return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 1), LIMIT_MAX) : LIMIT_DEFAULT;
}

/** The webhook column holds the secret we issued to the platform; it never leaves masked. */
function repositoryView(repository: AgentRepository): Record<string, unknown> {
  return {
    id: repository.id, connectionId: repository.connectionId, provider: repository.provider,
    pathWithNamespace: repository.pathWithNamespace, name: repository.name,
    webUrl: repository.webUrl, cloneUrl: repository.cloneUrl, defaultBranch: repository.defaultBranch,
    visibility: repository.visibility, description: repository.description,
    lastActivityAt: repository.lastActivityAt,
    webhook: maskRepositoryWebhook(repository),
  };
}

function linkView(link: AgentProjectRepository): Record<string, unknown> {
  return {
    id: link.id, projectId: link.projectId, repositoryId: link.repositoryId, connectionId: link.connectionId,
    provider: link.provider, role: link.role, isPrimary: link.isPrimary, syncIssues: link.syncIssues,
    isActive: link.isActive, config: link.config, lastSyncedAt: link.lastSyncedAt, lastError: link.lastError,
    repository: link.repository ? repositoryView(link.repository) : undefined,
  };
}

/** Transport-neutral refusals keep their kind visible in the text, the only thing MCP returns. */
function rethrow(error: unknown): never {
  if (error instanceof RepositoryLinkError) throw new Error(`${error.kind}: ${error.message}`);
  throw error;
}

const repositoriesTool: IMcpTool = {
  name: 'agentiz.repositories', group: 'agentiz',
  shortDescription: 'Lists git connections, their mirrored repositories and a project\'s linked ones.',
  description: 'Read-only view of the repository side of Agentiz. Without parameters returns the git connections (secrets masked; authorityMounted=false means its provider layer is not loaded and it cannot be synced) and the mirrored repositories. connectionId/search narrow the repositories; projectId adds that project\'s links (link ids are what agentiz.manageRepositories updateLink/unlink take). A repository just created on the platform appears here only after agentiz.manageRepositories sync.',
  mode: 'protected',
  inputSchema: {
    type: 'object',
    properties: {
      connectionId: { type: 'string' },
      projectId: { type: 'string', description: 'Also return the repositories linked to this project.' },
      search: { type: 'string', description: 'Substring of owner/name, case-insensitive.' },
      limit: { type: 'integer', default: LIMIT_DEFAULT, maximum: LIMIT_MAX },
    },
  },
  async handler(params) {
    const payload = objectParams(params);
    const connectionId = stringParam(payload, 'connectionId');
    const projectId = stringParam(payload, 'projectId');
    const search = stringParam(payload, 'search')?.toLowerCase();

    const connections = await AgentGitConnection.findAll({ order: [['createdAt', 'DESC']] });
    const repositories = await AgentRepository.findAll({
      where: connectionId ? { connectionId } : {},
      order: [['pathWithNamespace', 'ASC']],
    });
    const counts = new Map<string, number>();
    for (const repository of repositories) counts.set(repository.connectionId, (counts.get(repository.connectionId) ?? 0) + 1);
    const matching = search
      ? repositories.filter((repository) => repository.pathWithNamespace.toLowerCase().includes(search))
      : repositories;

    const links = projectId
      ? await AgentProjectRepository.findAll({
          where: { projectId },
          order: [['createdAt', 'ASC']],
          include: [{ model: AgentRepository, as: 'repository' }],
        })
      : null;

    return {
      connections: connections.map((connection) => ({
        ...maskConnectionForUI(connection),
        ...(connectionId ? {} : { repositoryCount: counts.get(connection.id) ?? 0 }),
        authorityMounted: Boolean(getGitConnectionAuthority(connection.provider)),
      })),
      repositoryCount: matching.length,
      repositories: matching.slice(0, limitParam(payload)).map(repositoryView),
      ...(links ? { projectLinks: links.map(linkView) } : {}),
    };
  },
};

async function resolveLink(payload: Params): Promise<AgentProjectRepository> {
  const linkId = stringParam(payload, 'linkId');
  const link = linkId
    ? await AgentProjectRepository.findByPk(linkId)
    : await AgentProjectRepository.findOne({
        where: { projectId: requiredString(payload, 'projectId'), repositoryId: requiredString(payload, 'repositoryId') },
      });
  if (!link) throw new Error('not_found: Link not found');
  return link;
}

/**
 * `repositoryId`, or `pathWithNamespace` as a person/agent knows it. A path that is not mirrored
 * yet triggers one sync (of `connectionId`, or of every active connection) before giving up — the
 * repository `gh` has just created is exactly the one the mirror does not know about.
 */
async function resolveRepository(payload: Params): Promise<{ repository: AgentRepository; synced: boolean }> {
  const repositoryId = stringParam(payload, 'repositoryId');
  if (repositoryId) {
    const repository = await AgentRepository.findByPk(repositoryId);
    if (!repository) throw new Error(`not_found: Repository ${repositoryId} not found`);
    return { repository, synced: false };
  }
  const path = stringParam(payload, 'pathWithNamespace');
  if (!path) throw new Error('repositoryId or pathWithNamespace is required');
  const connectionId = stringParam(payload, 'connectionId');

  let matches = await findRepositoryByPath(path, connectionId);
  let synced = false;
  if (!matches.length && payload.syncIfMissing !== false) {
    await syncConnectionRepositories(connectionId);
    synced = true;
    matches = await findRepositoryByPath(path, connectionId);
  }
  if (!matches.length) {
    throw new Error(`not_found: no connection sees repository ${path}${synced ? ' even after a sync' : ''} — check that the account it was created under is the one connected (agentiz.repositories lists connections), or that the connection's organisation access covers it`);
  }
  if (matches.length > 1) {
    throw new Error(`ambiguous: ${path} is reachable through ${matches.length} connections (${matches.map((m) => m.connectionId).join(', ')}); pass connectionId or repositoryId`);
  }
  return { repository: matches[0], synced };
}

const manageRepositoriesTool: IMcpTool = {
  name: 'agentiz.manageRepositories', group: 'agentiz-actions',
  shortDescription: 'Syncs git connections and links/unlinks repositories to projects.',
  description: 'Repository bookkeeping that used to exist only in the panel. sync re-mirrors one connection (connectionId) or every active one from the platform — run it after a repository was created outside Agentiz (e.g. an agent ran `gh repo create`). link connects a mirrored repository to a project by repositoryId or by pathWithNamespace ("owner/name"); with a path that is not mirrored yet it syncs once first (syncIfMissing, default true). Linking installs the repository webhook automatically when the server has a public URL; otherwise the 15-minute poll covers it. role: source (tasks come from its issues) | target (runs commit there) | both (default); isPrimary marks the repository used for tasks that carry none (one per project — others are demoted). updateLink changes those fields; unlink (confirm=true) removes the link and, if no other project uses the repository, its webhook. Repositories are never created or deleted on the platform by this tool.',
  mode: 'protected',
  inputSchema: {
    type: 'object',
    required: ['operation'],
    properties: {
      operation: { type: 'string', enum: ['sync', 'link', 'updateLink', 'unlink'] },
      connectionId: { type: 'string', description: 'sync: which connection (absent = all active). link: narrows a pathWithNamespace lookup.' },
      projectId: { type: 'string', description: 'link: required. updateLink/unlink: with repositoryId, instead of linkId.' },
      repositoryId: { type: 'string', description: 'AgentRepository.id (see agentiz.repositories).' },
      pathWithNamespace: { type: 'string', description: 'link only: "owner/name" instead of repositoryId.' },
      syncIfMissing: { type: 'boolean', default: true, description: 'link by path: sync connections once when the path is not mirrored yet.' },
      linkId: { type: 'string', description: 'updateLink/unlink: AgentProjectRepository.id.' },
      role: { type: 'string', enum: ['source', 'target', 'both'] },
      isPrimary: { type: 'boolean' },
      syncIssues: { type: 'boolean', description: 'Import the repository\'s issues as tasks. Default true on link.' },
      isActive: { type: 'boolean', description: 'updateLink only.' },
      config: { type: 'object', description: '{ pollIntervalSec?, query?, defaultBranch? }' },
      confirm: { type: 'boolean', description: 'Must be true for unlink.' },
    },
  },
  async handler(params) {
    const payload = objectParams(params);
    const operation = requiredString(payload, 'operation');
    try {
      if (operation === 'sync') {
        const results = await syncConnectionRepositories(stringParam(payload, 'connectionId'));
        return { operation, results };
      }

      if (operation === 'link') {
        const projectId = requiredString(payload, 'projectId');
        const { repository, synced } = await resolveRepository(payload);
        const link = await linkRepositoryToProject({
          projectId,
          repositoryId: repository.id,
          role: stringParam(payload, 'role') as ProjectRepositoryRole | undefined,
          isPrimary: boolParam(payload, 'isPrimary'),
          syncIssues: boolParam(payload, 'syncIssues'),
          config: payload.config as any,
        });
        return {
          operation, synced,
          link: linkView(link),
          repository: repositoryView(repository),
          note: 'The webhook is reconciled in the background; agentiz.repositories shows its state on the repository.',
        };
      }

      if (operation === 'updateLink') {
        const link = await resolveLink(payload);
        await updateProjectRepositoryLink(link, {
          role: stringParam(payload, 'role') as ProjectRepositoryRole | undefined,
          isPrimary: boolParam(payload, 'isPrimary'),
          syncIssues: boolParam(payload, 'syncIssues'),
          isActive: boolParam(payload, 'isActive'),
          config: payload.config !== undefined ? payload.config as any : undefined,
        });
        return { operation, link: linkView(link) };
      }

      if (operation === 'unlink') {
        if (payload.confirm !== true) throw new Error('confirm:true is required to unlink a repository');
        const link = await resolveLink(payload);
        const view = linkView(link);
        await link.destroy();
        return { operation, unlinked: true, link: view };
      }
    } catch (error) {
      rethrow(error);
    }
    throw new Error(`Unsupported operation: ${operation}`);
  },
};

export const agentizRepositoryMcpTools: IMcpTool[] = [repositoriesTool, manageRepositoriesTool];
