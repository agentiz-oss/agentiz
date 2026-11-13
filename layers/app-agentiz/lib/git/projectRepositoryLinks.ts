import { Op, col, fn, where } from 'sequelize';
import { AgentGitConnection } from '../../models/AgentGitConnection';
import { AgentProject } from '../../models/AgentProject';
import { AgentProjectRepository } from '../../models/AgentProjectRepository';
import { AgentRepository } from '../../models/AgentRepository';
import type { ProjectRepositoryConfig, ProjectRepositoryRole } from '../../types/agentiz';
import { requireGitConnectionAuthority, type RepositorySyncResult } from './connections';

/**
 * Linking a mirrored repository to a project, for every caller that does it on purpose — the
 * panel's repositories screen and the MCP tools.
 *
 * The webhook and the "one primary per project" invariant are not here: the first follows the
 * link from the model's own hooks (four writers, one place), the second is
 * `AgentProjectRepository.demoteOtherPrimaries`. What this module adds is only the part both
 * deliberate callers used to spell separately — find the repository, refuse a duplicate, copy the
 * denormalized `provider`/`connectionId` — so a link made over MCP is the same row the panel makes.
 */

/** A refusal the caller maps onto its own transport (HTTP status, MCP error text). */
export class RepositoryLinkError extends Error {
  constructor(readonly kind: 'not_found' | 'conflict' | 'invalid', message: string) {
    super(message);
  }
}

export interface LinkRepositoryInput {
  projectId: string;
  repositoryId: string;
  role?: ProjectRepositoryRole;
  isPrimary?: boolean;
  syncIssues?: boolean;
  config?: ProjectRepositoryConfig | null;
}

const ROLES: readonly ProjectRepositoryRole[] = ['source', 'target', 'both'];

function roleOf(value: unknown, fallback: ProjectRepositoryRole): ProjectRepositoryRole {
  if (value === undefined || value === null) return fallback;
  if (!ROLES.includes(value as ProjectRepositoryRole)) {
    throw new RepositoryLinkError('invalid', `role must be one of ${ROLES.join(', ')}`);
  }
  return value as ProjectRepositoryRole;
}

export async function linkRepositoryToProject(input: LinkRepositoryInput): Promise<AgentProjectRepository> {
  const [project, repository] = await Promise.all([
    AgentProject.findByPk(input.projectId),
    AgentRepository.findByPk(input.repositoryId),
  ]);
  if (!project) throw new RepositoryLinkError('not_found', 'Agentiz project not found');
  if (!repository) throw new RepositoryLinkError('not_found', 'Repository not found');

  const existing = await AgentProjectRepository.findOne({ where: { projectId: project.id, repositoryId: repository.id } });
  if (existing) throw new RepositoryLinkError('conflict', 'This repository is already linked');

  const link = await AgentProjectRepository.create({
    projectId: project.id,
    provider: repository.provider,
    connectionId: repository.connectionId,
    repositoryId: repository.id,
    role: roleOf(input.role, 'both'),
    isPrimary: Boolean(input.isPrimary),
    syncIssues: input.syncIssues !== false,
    isActive: true,
    config: input.config ?? null,
  });
  if (link.isPrimary) await AgentProjectRepository.demoteOtherPrimaries(link);
  return link;
}

export interface UpdateLinkInput {
  role?: ProjectRepositoryRole;
  isPrimary?: boolean;
  syncIssues?: boolean;
  isActive?: boolean;
  config?: ProjectRepositoryConfig | null;
}

export async function updateProjectRepositoryLink(link: AgentProjectRepository, input: UpdateLinkInput): Promise<AgentProjectRepository> {
  await link.update({
    role: roleOf(input.role, link.role),
    isPrimary: input.isPrimary !== undefined ? Boolean(input.isPrimary) : link.isPrimary,
    syncIssues: input.syncIssues !== undefined ? Boolean(input.syncIssues) : link.syncIssues,
    isActive: input.isActive !== undefined ? Boolean(input.isActive) : link.isActive,
    config: input.config !== undefined ? input.config : link.config,
  });
  if (link.isPrimary) await AgentProjectRepository.demoteOtherPrimaries(link);
  return link;
}

/** One connection, or every active one when `connectionId` is absent. */
export async function syncConnectionRepositories(connectionId?: string): Promise<RepositorySyncResult[]> {
  const connections = connectionId
    ? [await AgentGitConnection.findByPk(connectionId)]
    : await AgentGitConnection.findAll({ where: { status: 'active' } });
  const results: RepositorySyncResult[] = [];
  for (const connection of connections) {
    if (!connection) throw new RepositoryLinkError('not_found', 'Connection not found');
    results.push(await requireGitConnectionAuthority(connection.provider).syncRepositories(connection));
  }
  return results;
}

/**
 * Finds a mirrored repository by `owner/name`, case-insensitively — what a person or an agent
 * knows right after `gh repo create`, long before anyone has seen our id for it.
 *
 * More than one match is possible (the same repository reachable through two connections) and is
 * refused rather than guessed: the connection decides whose token the runs will use.
 */
export async function findRepositoryByPath(pathWithNamespace: string, connectionId?: string): Promise<AgentRepository[]> {
  const wanted = pathWithNamespace.trim().replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '').toLowerCase();
  // lower() on both sides: LIKE/= differ in case sensitivity between sqlite and postgres.
  return AgentRepository.findAll({
    where: {
      [Op.and]: [
        ...(connectionId ? [{ connectionId }] : []),
        where(fn('lower', col('pathWithNamespace')), wanted),
      ],
    },
  });
}
