import { AbstractApp, AppManager, Collection } from '@nodeknit/app-manager';
import type { Migration } from '@nodeknit/app-manager';
import { AdminizerRouteMiddleware, generateAdminizerModelConfig } from '@nodeknit/app-adminizer';
import cron, { type ScheduledTask } from 'node-cron';
import { migrations } from './migrations';
import { GitlabOAuthApp } from './models/GitlabOAuthApp';
import { GitlabConnection } from './models/GitlabConnection';
import { GitlabRepository } from './models/GitlabRepository';
import { AgentProjectIntegration } from './models/AgentProjectIntegration';
import { GitlabOAuthState } from './models/GitlabOAuthState';
import { GitlabOAuthService, GitlabOAuthError } from './services/GitlabOAuthService';
import { GitlabRepositorySyncService } from './services/GitlabRepositorySyncService';
import { GitlabIssueSyncService } from './services/GitlabIssueSyncService';
import { IntegrationResolverService } from './services/IntegrationResolverService';
import { maskModelForUI, restoreMaskedSecrets } from './lib/secrets';
import { gitlabProviderAdapter } from './lib/GitLabProvider';
import { DEFAULT_GITLAB_BASE_URL, DEFAULT_GITLAB_SCOPES } from './types/gitlab';
import { AgentProject } from '../app-agentiz/models/AgentProject';
import { GitSyncService } from '../app-agentiz/services/GitSyncService';
import {
  registerTaskGitProviderResolver,
  registerTaskRepositoryResolver,
  unregisterTaskGitProviderResolver,
  unregisterTaskRepositoryResolver,
} from '../app-agentiz/lib/git';
import type { GitProviderAdapter } from '../app-agentiz/lib/git';

const APP_ID = 'app-agentiz-gitlab-integration';
/** Route under the Adminizer prefix, e.g. /dashboard/agentiz-gitlab. */
const ROUTE = '/agentiz-gitlab';
const CALLBACK_ROUTE = `${ROUTE}/oauth/callback`;
const SYNC_CRON = process.env.AGENTIZ_GITLAB_SYNC_CRON ?? '*/15 * * * *';

type Req = Parameters<AdminizerRouteMiddleware['handler']>[0];

/** Public origin of this server, honouring a reverse proxy. */
function publicOrigin(req: Req): string {
  const configured = process.env.AGENTIZ_PUBLIC_URL ?? process.env.PUBLIC_URL;
  if (configured) return configured.replace(/\/+$/, '');
  const proto = (req.header('x-forwarded-proto') ?? req.protocol ?? 'http').split(',')[0].trim();
  return `${proto}://${req.header('x-forwarded-host') ?? req.header('host')}`;
}

/**
 * The Adminizer prefix is not known to the layer, but every request to it carries it: strip our own
 * route from the original URL and whatever is left is the prefix.
 */
function routePrefix(req: Req): string {
  const index = req.originalUrl.indexOf(ROUTE);
  return index > 0 ? req.originalUrl.slice(0, index) : '';
}

function defaultRedirectUri(req: Req): string {
  return `${publicOrigin(req)}${routePrefix(req)}${CALLBACK_ROUTE}`;
}

function htmlPage(title: string, body: string, redirectTo: string | null): string {
  const redirect = redirectTo
    ? `<meta http-equiv="refresh" content="2;url=${redirectTo}"><p>Возврат в <a href="${redirectTo}">Agentiz</a>…</p>`
    : '';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title>${redirect}</head>
<body style="font-family:system-ui;padding:2rem"><h1>${title}</h1>${body}</body></html>`;
}

/**
 * GitLab integration layer for Agentiz.
 *
 * Authorization goes through a GitLab OAuth application (authorization code + PKCE), the resulting
 * connection is used to mirror every reachable GitLab project, and any number of those repositories
 * can be linked to one Agentiz project — from several accounts and several GitLab instances at once.
 * Issue sync and repository resolution are plugged into app-agentiz through its registries, so the
 * pipeline commits and comments back into the repository each task actually came from.
 */
export class AppAgentizGitlabIntegration extends AbstractApp {
  appId: string = APP_ID;
  name: string = 'App Agentiz GitLab Integration';

  private syncTask: ScheduledTask | null = null;

  @Collection
  migrations: Migration[] = migrations.umzug;

  @Collection
  models: any[] = [GitlabOAuthApp, GitlabConnection, GitlabRepository, AgentProjectIntegration, GitlabOAuthState];

  /**
   * The GitLab adapter itself: this layer owns GitLabProvider and hands it to app-agentiz through
   * the `gitProviders` collection, so `repoProvider: 'gitlab'` works only while this layer is on.
   */
  @Collection
  gitProviders: GitProviderAdapter[] = [gitlabProviderAdapter];

  @Collection
  adminizerMiddlewares: AdminizerRouteMiddleware[] = [
    {
      route: CALLBACK_ROUTE,
      method: 'get',
      handler: async (req, res) => {
        const back = `${routePrefix(req)}${ROUTE}`;
        try {
          const error = typeof req.query.error === 'string' ? req.query.error : null;
          if (error) {
            const description = typeof req.query.error_description === 'string' ? req.query.error_description : '';
            return res
              .status(400)
              .send(htmlPage('GitLab: авторизация отклонена', `<p>${error} ${description}</p>`, back));
          }

          const code = typeof req.query.code === 'string' ? req.query.code : '';
          const state = typeof req.query.state === 'string' ? req.query.state : '';
          if (!code || !state) {
            return res.status(400).send(htmlPage('GitLab: неполный ответ', '<p>code или state отсутствует</p>', back));
          }

          const { connection, returnTo } = await GitlabOAuthService.handleCallback({ code, state });
          // First sync right away so the repository picker is populated when the user returns.
          await GitlabRepositorySyncService.syncConnection(connection.id).catch((): undefined => undefined);

          return res.send(
            htmlPage(
              'GitLab подключён',
              `<p>Аккаунт <b>${connection.username ?? connection.gitlabUserId}</b> авторизован.</p>`,
              returnTo || back,
            ),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return res.status(400).send(htmlPage('GitLab: ошибка авторизации', `<p>${message}</p>`, back));
        }
      },
    },
    {
      route: ROUTE,
      method: 'get',
      handler: async (req, res, next) => {
        if (req.path.endsWith('/oauth/callback')) return next();

        const method = req.query._method as string | undefined;

        if (method === 'getOAuthApps') {
          const apps = await GitlabOAuthApp.findAll({ order: [['createdAt', 'DESC']] });
          return res.json({
            data: apps.map((app) => ({
              ...maskModelForUI(app),
              callbackUrl: app.redirectUri || defaultRedirectUri(req),
            })),
          });
        }

        if (method === 'getConnections') {
          const connections = await GitlabConnection.findAll({
            order: [['createdAt', 'DESC']],
            include: [{ model: GitlabOAuthApp, as: 'oauthApp' }],
          });
          return res.json({
            data: connections.map((connection) => ({
              ...maskModelForUI(connection),
              oauthAppName: connection.oauthApp?.name ?? null,
              baseUrl: connection.oauthApp?.baseUrl ?? null,
            })),
          });
        }

        if (method === 'getRepositories') {
          const connectionId = typeof req.query.connectionId === 'string' ? req.query.connectionId : '';
          const search = typeof req.query.search === 'string' ? req.query.search.toLowerCase() : '';
          const repositories = await GitlabRepository.findAll({
            where: connectionId ? { connectionId } : {},
            order: [['pathWithNamespace', 'ASC']],
            limit: 1000,
          });
          const filtered = search
            ? repositories.filter((repo) => repo.pathWithNamespace.toLowerCase().includes(search))
            : repositories;
          return res.json({ data: filtered.map((repo) => repo.toJSON()) });
        }

        if (method === 'getIntegrations') {
          const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
          const integrations = await AgentProjectIntegration.findAll({
            where: projectId ? { projectId } : {},
            order: [['createdAt', 'DESC']],
            include: [
              { model: GitlabRepository, as: 'repository' },
              { model: GitlabConnection, as: 'connection' },
            ],
          });
          return res.json({
            data: integrations.map((integration) => ({
              ...integration.toJSON(),
              connection: maskModelForUI(integration.connection ?? null),
              repository: integration.repository?.toJSON() ?? null,
            })),
          });
        }

        if (method === 'getProjects') {
          const projects = await AgentProject.findAll({ order: [['name', 'ASC']] });
          return res.json({
            data: projects.map((project) => ({
              id: project.id,
              name: project.name,
              slug: project.slug,
              isActive: project.isActive,
            })),
          });
        }

        return req.Inertia.render({
          component: 'module',
          props: {
            moduleComponent: '/dashboard/modules/AgentizGitlab.js',
          },
        });
      },
    },
    {
      route: ROUTE,
      method: 'post',
      handler: async (req, res) => {
        try {
          const method = req.body?._method as string | undefined;

          if (method === 'createOAuthApp') {
            const app = await GitlabOAuthApp.create({
              name: String(req.body?.name ?? '').trim() || 'GitLab',
              baseUrl: (String(req.body?.baseUrl ?? '').trim() || DEFAULT_GITLAB_BASE_URL).replace(/\/+$/, ''),
              applicationId: String(req.body?.applicationId ?? '').trim(),
              secrets: { clientSecret: String(req.body?.clientSecret ?? '') },
              redirectUri: req.body?.redirectUri ? String(req.body.redirectUri) : null,
              scopes: Array.isArray(req.body?.scopes) ? req.body.scopes : DEFAULT_GITLAB_SCOPES,
              isActive: req.body?.isActive !== false,
            });
            return res.json({ data: maskModelForUI(app) });
          }

          if (method === 'updateOAuthApp') {
            const app = await GitlabOAuthApp.findByPk(String(req.body?.id ?? ''));
            if (!app) return res.status(404).json({ message: 'OAuth app not found' });
            const secrets = restoreMaskedSecrets(
              req.body?.clientSecret !== undefined ? { clientSecret: String(req.body.clientSecret) } : app.secrets,
              app.secrets,
            );
            await app.update({
              name: req.body?.name !== undefined ? String(req.body.name) : app.name,
              baseUrl:
                req.body?.baseUrl !== undefined ? String(req.body.baseUrl).replace(/\/+$/, '') : app.baseUrl,
              applicationId:
                req.body?.applicationId !== undefined ? String(req.body.applicationId) : app.applicationId,
              secrets,
              redirectUri: req.body?.redirectUri !== undefined ? req.body.redirectUri || null : app.redirectUri,
              scopes: Array.isArray(req.body?.scopes) ? req.body.scopes : app.scopes,
              isActive: req.body?.isActive !== undefined ? Boolean(req.body.isActive) : app.isActive,
            });
            return res.json({ data: maskModelForUI(app) });
          }

          if (method === 'deleteOAuthApp') {
            const app = await GitlabOAuthApp.findByPk(String(req.body?.id ?? ''));
            if (!app) return res.status(404).json({ message: 'OAuth app not found' });
            await app.destroy();
            return res.json({ data: { ok: true } });
          }

          if (method === 'startOAuth') {
            const { authorizeUrl } = await GitlabOAuthService.start({
              oauthAppId: String(req.body?.oauthAppId ?? ''),
              redirectUri: defaultRedirectUri(req),
              returnTo: req.body?.returnTo ? String(req.body.returnTo) : `${routePrefix(req)}${ROUTE}`,
              ownerId: (req as any).user?.id ?? null,
            });
            return res.json({ data: { authorizeUrl } });
          }

          if (method === 'disconnect') {
            const connection = await GitlabOAuthService.disconnect(String(req.body?.connectionId ?? ''));
            return res.json({ data: maskModelForUI(connection) });
          }

          if (method === 'deleteConnection') {
            const connection = await GitlabConnection.findByPk(String(req.body?.connectionId ?? ''));
            if (!connection) return res.status(404).json({ message: 'Connection not found' });
            await connection.destroy();
            return res.json({ data: { ok: true } });
          }

          if (method === 'syncRepositories') {
            const connectionId = String(req.body?.connectionId ?? '');
            const data = connectionId
              ? [await GitlabRepositorySyncService.syncConnection(connectionId)]
              : await GitlabRepositorySyncService.syncAllActiveConnections();
            return res.json({ data });
          }

          if (method === 'linkRepository') {
            const projectId = String(req.body?.projectId ?? '');
            const repositoryId = String(req.body?.repositoryId ?? '');
            if (!projectId || !repositoryId) {
              return res.status(400).json({ message: 'projectId and repositoryId are required' });
            }
            const repository = await GitlabRepository.findByPk(repositoryId);
            if (!repository) return res.status(404).json({ message: 'Repository not found' });
            const project = await AgentProject.findByPk(projectId);
            if (!project) return res.status(404).json({ message: 'Agentiz project not found' });

            const existing = await AgentProjectIntegration.findOne({ where: { projectId, repositoryId } });
            if (existing) return res.status(409).json({ message: 'This repository is already linked' });

            const integration = await AgentProjectIntegration.create({
              projectId,
              provider: 'gitlab',
              connectionId: repository.connectionId,
              repositoryId,
              role: req.body?.role ?? 'both',
              isPrimary: Boolean(req.body?.isPrimary),
              syncIssues: req.body?.syncIssues !== false,
              isActive: true,
              config: req.body?.config ?? null,
            });
            if (integration.isPrimary) await this.demoteOtherPrimaries(integration);
            return res.json({ data: integration.toJSON() });
          }

          if (method === 'updateIntegration') {
            const integration = await AgentProjectIntegration.findByPk(String(req.body?.integrationId ?? ''));
            if (!integration) return res.status(404).json({ message: 'Integration not found' });
            await integration.update({
              role: req.body?.role ?? integration.role,
              isPrimary: req.body?.isPrimary !== undefined ? Boolean(req.body.isPrimary) : integration.isPrimary,
              syncIssues: req.body?.syncIssues !== undefined ? Boolean(req.body.syncIssues) : integration.syncIssues,
              isActive: req.body?.isActive !== undefined ? Boolean(req.body.isActive) : integration.isActive,
              config: req.body?.config !== undefined ? req.body.config : integration.config,
            });
            if (integration.isPrimary) await this.demoteOtherPrimaries(integration);
            return res.json({ data: integration.toJSON() });
          }

          if (method === 'unlinkIntegration') {
            const integration = await AgentProjectIntegration.findByPk(String(req.body?.integrationId ?? ''));
            if (!integration) return res.status(404).json({ message: 'Integration not found' });
            await integration.destroy();
            return res.json({ data: { ok: true } });
          }

          if (method === 'syncIntegration') {
            const data = await GitlabIssueSyncService.syncIntegration(String(req.body?.integrationId ?? ''), {
              force: true,
            });
            return res.json({ data });
          }

          if (method === 'syncProjectIntegrations') {
            const project = await AgentProject.findByPk(String(req.body?.projectId ?? ''));
            if (!project) return res.status(404).json({ message: 'Agentiz project not found' });
            const data = await GitlabIssueSyncService.syncProject(project, { force: true });
            return res.json({ data });
          }

          if (method === 'syncAllIntegrations') {
            return res.json({ data: await GitlabIssueSyncService.syncAll({ force: true }) });
          }

          return res.status(400).json({ message: `Unknown _method: ${method ?? '(none)'}` });
        } catch (error: any) {
          const status = error instanceof GitlabOAuthError ? 400 : 400;
          return res.status(status).json({ message: error?.message ?? String(error) });
        }
      },
    },
  ];

  constructor(appManager: AppManager) {
    super(appManager);
  }

  /** Only one repository per project may be the fallback target. */
  private async demoteOtherPrimaries(integration: AgentProjectIntegration): Promise<void> {
    const siblings = await AgentProjectIntegration.findAll({
      where: { projectId: integration.projectId, isPrimary: true },
    });
    for (const sibling of siblings) {
      if (sibling.id !== integration.id) await sibling.update({ isPrimary: false });
    }
  }

  async mount(): Promise<void> {
    const configs = [
      generateAdminizerModelConfig(GitlabOAuthApp),
      generateAdminizerModelConfig(GitlabConnection),
      generateAdminizerModelConfig(GitlabRepository),
      generateAdminizerModelConfig(AgentProjectIntegration),
    ].map((item) => ({ appId: this.appId, item }));
    await this.appManager.collectionStorage.append('adminizerModelConfigs', configs);

    // Plug into app-agentiz: issues of linked repositories are part of a project sync, and tasks
    // that came from a link are acted upon in their own repository with their own token.
    GitSyncService.registerSyncContributor(this.appId, (project) => GitlabIssueSyncService.syncProject(project));
    registerTaskGitProviderResolver(this.appId, (task, project) =>
      IntegrationResolverService.resolveProvider(task, project),
    );
    registerTaskRepositoryResolver(this.appId, (task, project) =>
      IntegrationResolverService.resolveRepository(task, project),
    );

    if (process.env.AGENTIZ_GITLAB_SYNC_ENABLED === 'true') {
      this.syncTask = cron.schedule(SYNC_CRON, () => {
        void (async () => {
          await GitlabRepositorySyncService.syncAllActiveConnections();
          await GitlabIssueSyncService.syncAll();
        })().catch((error) => {
          console.error(`[${APP_ID}] scheduled sync failed:`, error);
        });
      });
      console.log(`[${APP_ID}] GitLab sync scheduled: ${SYNC_CRON}`);
    } else {
      console.log(`[${APP_ID}] GitLab sync disabled (set AGENTIZ_GITLAB_SYNC_ENABLED=true to enable)`);
    }
  }

  async unmount(): Promise<void> {
    if (this.syncTask) {
      this.syncTask.stop();
      this.syncTask = null;
    }
    GitSyncService.unregisterSyncContributor(this.appId);
    unregisterTaskGitProviderResolver(this.appId);
    unregisterTaskRepositoryResolver(this.appId);
  }
}

export default AppAgentizGitlabIntegration;
