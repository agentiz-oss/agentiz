import type { AdminizerRouteMiddleware } from '@nodeknit/app-adminizer';
import { AgentProject } from '../models/AgentProject';
import { AgentGitConnection } from '../models/AgentGitConnection';
import { AgentProjectRepository } from '../models/AgentProjectRepository';
import { AgentRepository } from '../models/AgentRepository';
import { getGitConnectionAuthority, listGitConnectionProviders, requireGitConnectionAuthority } from './git';
import { maskConnectionForUI } from './secrets';
import type { GitProviderType } from '../types/agentiz';

/**
 * The shared repositories screen: connections, their mirrored repositories and the links to
 * projects — for every platform at once.
 *
 * It lives in the core rather than in a provider layer because all three are core models now. What
 * stays in a layer is only its OAuth application page, which is genuinely platform-shaped
 * (GitLab has an application id and PKCE, GitHub a client id and none).
 */
const ROUTE = '/agentiz-repos';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Where each platform's OAuth application is configured, so the UI can offer "add a connection". */
function providerPages(): Array<{ provider: GitProviderType; route: string }> {
  return listGitConnectionProviders().map((provider) => ({ provider, route: `/agentiz-${provider}` }));
}

export const repositoryRoutes: AdminizerRouteMiddleware[] = [
  {
    route: ROUTE,
    method: 'get',
    handler: async (req, res) => {
      const method = str(req.query._method);

      if (method === 'getConnections') {
        const connections = await AgentGitConnection.findAll({ order: [['createdAt', 'DESC']] });
        const counts = new Map<string, number>();
        for (const repository of await AgentRepository.findAll({ attributes: ['connectionId'] })) {
          counts.set(repository.connectionId, (counts.get(repository.connectionId) ?? 0) + 1);
        }
        return res.json({
          data: connections.map((connection) => ({
            ...maskConnectionForUI(connection),
            repositoryCount: counts.get(connection.id) ?? 0,
            // A connection whose layer is unmounted cannot be refreshed or synced; the UI says so
            // instead of offering buttons that will fail.
            authorityMounted: Boolean(getGitConnectionAuthority(connection.provider)),
          })),
          meta: { providers: providerPages() },
        });
      }

      if (method === 'getRepositories') {
        const connectionId = str(req.query.connectionId);
        const search = str(req.query.search).toLowerCase();
        const repositories = await AgentRepository.findAll({
          where: connectionId ? { connectionId } : {},
          order: [['pathWithNamespace', 'ASC']],
          limit: 1000,
        });
        const filtered = search
          ? repositories.filter((repository) => repository.pathWithNamespace.toLowerCase().includes(search))
          : repositories;
        return res.json({ data: filtered.map((repository) => repository.toJSON()) });
      }

      if (method === 'getProjectRepositories') {
        const projectId = str(req.query.projectId);
        const links = await AgentProjectRepository.findAll({
          where: projectId ? { projectId } : {},
          order: [['createdAt', 'ASC']],
          include: [
            { model: AgentRepository, as: 'repository' },
            { model: AgentGitConnection, as: 'connection' },
          ],
        });
        return res.json({
          data: links.map((link) => ({
            ...link.toJSON(),
            repository: link.repository?.toJSON() ?? null,
            connection: maskConnectionForUI(link.connection ?? null),
          })),
        });
      }

      if (method === 'getProjects') {
        const projects = await AgentProject.findAll({ order: [['name', 'ASC']] });
        return res.json({
          data: projects.map((project) => ({ id: project.id, name: project.name, slug: project.slug, isActive: project.isActive })),
        });
      }

      return req.Inertia.render({
        component: 'module',
        props: { moduleComponent: '/dashboard/modules/AgentizRepositories.js' },
      });
    },
  },
  {
    route: ROUTE,
    method: 'post',
    handler: async (req, res) => {
      try {
        const method = str(req.body?._method);

        if (method === 'syncConnectionRepositories') {
          const connectionId = str(req.body?.connectionId);
          const connections = connectionId
            ? [await AgentGitConnection.findByPk(connectionId)]
            : await AgentGitConnection.findAll({ where: { status: 'active' } });
          const results = [];
          for (const connection of connections) {
            if (!connection) return res.status(404).json({ message: 'Connection not found' });
            const authority = requireGitConnectionAuthority(connection.provider);
            results.push(await authority.syncRepositories(connection));
          }
          return res.json({ data: results });
        }

        if (method === 'disconnectConnection') {
          const connection = await AgentGitConnection.findByPk(str(req.body?.connectionId));
          if (!connection) return res.status(404).json({ message: 'Connection not found' });
          const authority = getGitConnectionAuthority(connection.provider);
          // Revoking upstream is best effort; the local row is marked either way, otherwise a
          // platform outage would leave a connection that looks usable and is not.
          if (authority?.disconnect) await authority.disconnect(connection);
          else await connection.update({ secrets: null, expiresAt: null, status: 'revoked' });
          await connection.reload();
          return res.json({ data: maskConnectionForUI(connection) });
        }

        if (method === 'deleteConnection') {
          const connection = await AgentGitConnection.findByPk(str(req.body?.connectionId));
          if (!connection) return res.status(404).json({ message: 'Connection not found' });
          await connection.destroy();
          return res.json({ data: { ok: true } });
        }

        if (method === 'linkRepository') {
          const projectId = str(req.body?.projectId);
          const repositoryId = str(req.body?.repositoryId);
          if (!projectId || !repositoryId) {
            return res.status(400).json({ message: 'projectId and repositoryId are required' });
          }
          const [project, repository] = await Promise.all([
            AgentProject.findByPk(projectId),
            AgentRepository.findByPk(repositoryId),
          ]);
          if (!project) return res.status(404).json({ message: 'Agentiz project not found' });
          if (!repository) return res.status(404).json({ message: 'Repository not found' });

          const existing = await AgentProjectRepository.findOne({ where: { projectId, repositoryId } });
          if (existing) return res.status(409).json({ message: 'This repository is already linked' });

          const link = await AgentProjectRepository.create({
            projectId,
            provider: repository.provider,
            connectionId: repository.connectionId,
            repositoryId,
            role: req.body?.role ?? 'both',
            isPrimary: Boolean(req.body?.isPrimary),
            syncIssues: req.body?.syncIssues !== false,
            isActive: true,
            config: req.body?.config ?? null,
          });
          if (link.isPrimary) await AgentProjectRepository.demoteOtherPrimaries(link);
          return res.json({ data: link.toJSON() });
        }

        if (method === 'updateProjectRepository') {
          const link = await AgentProjectRepository.findByPk(str(req.body?.linkId));
          if (!link) return res.status(404).json({ message: 'Link not found' });
          await link.update({
            role: req.body?.role ?? link.role,
            isPrimary: req.body?.isPrimary !== undefined ? Boolean(req.body.isPrimary) : link.isPrimary,
            syncIssues: req.body?.syncIssues !== undefined ? Boolean(req.body.syncIssues) : link.syncIssues,
            isActive: req.body?.isActive !== undefined ? Boolean(req.body.isActive) : link.isActive,
            config: req.body?.config !== undefined ? req.body.config : link.config,
          });
          if (link.isPrimary) await AgentProjectRepository.demoteOtherPrimaries(link);
          return res.json({ data: link.toJSON() });
        }

        if (method === 'unlinkRepository') {
          const link = await AgentProjectRepository.findByPk(str(req.body?.linkId));
          if (!link) return res.status(404).json({ message: 'Link not found' });
          await link.destroy();
          return res.json({ data: { ok: true } });
        }

        return res.status(400).json({ message: `Unknown _method: ${method || '(none)'}` });
      } catch (error: any) {
        return res.status(400).json({ message: error?.message ?? String(error) });
      }
    },
  },
];
