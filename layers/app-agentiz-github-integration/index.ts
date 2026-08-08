import { AbstractApp, AppManager, Collection } from '@nodeknit/app-manager';
import type { Migration } from '@nodeknit/app-manager';
import { AdminizerRouteMiddleware, generateAdminizerModelConfig } from '@nodeknit/app-adminizer';
import cron, { type ScheduledTask } from 'node-cron';
import { migrations } from './migrations';
import { GithubOAuthApp } from './models/GithubOAuthApp';
import { GithubOAuthState } from './models/GithubOAuthState';
import { GithubOAuthService, GithubOAuthError } from './services/GithubOAuthService';
import { GithubRepositorySyncService, githubConnectionAuthority } from './services/GithubRepositorySyncService';
import { GithubIssueSyncService } from './services/GithubIssueSyncService';
import { maskModelForUI, restoreMaskedSecrets } from './lib/secrets';
import { DEFAULT_GITHUB_BASE_URL, DEFAULT_GITHUB_SCOPES } from './types/github';
import { GitSyncService } from '../app-agentiz/services/GitSyncService';
import {
  registerGitConnectionAuthority,
  unregisterGitConnectionAuthority,
} from '../app-agentiz/lib/git';

const APP_ID = 'app-agentiz-github-integration';
/** Route under the Adminizer prefix, e.g. /dashboard/agentiz-github. */
const ROUTE = '/agentiz-github';
const CALLBACK_ROUTE = `${ROUTE}/oauth/callback`;
const SYNC_CRON = process.env.AGENTIZ_GITHUB_SYNC_CRON ?? '*/15 * * * *';

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
 * GitHub integration layer for Agentiz.
 *
 * Deliberately thin: authorization goes through a GitHub OAuth application, the resulting
 * connection is used to mirror every reachable repository, and everything after that — which
 * repositories a project uses, which runner may take them, what the pipeline does with them — is
 * core business shared with every other platform.
 *
 * What genuinely differs from the GitLab layer is spelled out where it lives: no PKCE
 * (GithubOAuthState), two token lifetime modes (GithubOAuthService), a form-urlencoded token
 * response that reports errors with HTTP 200 (GithubOAuthClient), and two different roots for the
 * site and the API (types/github.ts).
 */
export class AppAgentizGithubIntegration extends AbstractApp {
  appId: string = APP_ID;
  name: string = 'App Agentiz GitHub Integration';

  private syncTask: ScheduledTask | null = null;

  @Collection
  migrations: Migration[] = migrations.umzug;

  @Collection
  models: any[] = [GithubOAuthApp, GithubOAuthState];

  // No `gitProviders` entry: app-agentiz ships the GitHub adapter itself (githubProviderAdapter),
  // because GitHub is also usable with a plain personal access token and no layer at all.

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
              .send(htmlPage('GitHub: авторизация отклонена', `<p>${error} ${description}</p>`, back));
          }

          const code = typeof req.query.code === 'string' ? req.query.code : '';
          const state = typeof req.query.state === 'string' ? req.query.state : '';
          if (!code || !state) {
            return res.status(400).send(htmlPage('GitHub: неполный ответ', '<p>code или state отсутствует</p>', back));
          }

          const { connection, returnTo } = await GithubOAuthService.handleCallback({ code, state });
          // First sync right away so the repository picker is populated when the user returns.
          await GithubRepositorySyncService.sync(connection).catch((): undefined => undefined);

          return res.send(
            htmlPage(
              'GitHub подключён',
              `<p>Аккаунт <b>${connection.username ?? connection.externalUserId}</b> авторизован.</p>`,
              returnTo || back,
            ),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return res.status(400).send(htmlPage('GitHub: ошибка авторизации', `<p>${message}</p>`, back));
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
          const apps = await GithubOAuthApp.findAll({ order: [['createdAt', 'DESC']] });
          return res.json({
            data: apps.map((app) => ({
              ...maskModelForUI(app),
              // The most commonly mis-configured field, so it is served ready to paste into GitHub.
              callbackUrl: app.redirectUri || defaultRedirectUri(req),
            })),
          });
        }

        return req.Inertia.render({
          component: 'module',
          props: {
            moduleComponent: '/dashboard/modules/AgentizGithub.js',
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
            const app = await GithubOAuthApp.create({
              name: String(req.body?.name ?? '').trim() || 'GitHub',
              baseUrl: (String(req.body?.baseUrl ?? '').trim() || DEFAULT_GITHUB_BASE_URL).replace(/\/+$/, ''),
              clientId: String(req.body?.clientId ?? '').trim(),
              secrets: { clientSecret: String(req.body?.clientSecret ?? '') },
              redirectUri: req.body?.redirectUri ? String(req.body.redirectUri) : null,
              scopes: Array.isArray(req.body?.scopes) ? req.body.scopes : DEFAULT_GITHUB_SCOPES,
              isActive: req.body?.isActive !== false,
            });
            return res.json({ data: maskModelForUI(app) });
          }

          if (method === 'updateOAuthApp') {
            const app = await GithubOAuthApp.findByPk(String(req.body?.id ?? ''));
            if (!app) return res.status(404).json({ message: 'OAuth app not found' });
            const secrets = restoreMaskedSecrets(
              req.body?.clientSecret !== undefined ? { clientSecret: String(req.body.clientSecret) } : app.secrets,
              app.secrets,
            );
            await app.update({
              name: req.body?.name !== undefined ? String(req.body.name) : app.name,
              baseUrl: req.body?.baseUrl !== undefined ? String(req.body.baseUrl).replace(/\/+$/, '') : app.baseUrl,
              clientId: req.body?.clientId !== undefined ? String(req.body.clientId) : app.clientId,
              secrets,
              redirectUri: req.body?.redirectUri !== undefined ? req.body.redirectUri || null : app.redirectUri,
              scopes: Array.isArray(req.body?.scopes) ? req.body.scopes : app.scopes,
              isActive: req.body?.isActive !== undefined ? Boolean(req.body.isActive) : app.isActive,
            });
            return res.json({ data: maskModelForUI(app) });
          }

          if (method === 'deleteOAuthApp') {
            const app = await GithubOAuthApp.findByPk(String(req.body?.id ?? ''));
            if (!app) return res.status(404).json({ message: 'OAuth app not found' });
            await app.destroy();
            return res.json({ data: { ok: true } });
          }

          if (method === 'startOAuth') {
            const { authorizeUrl } = await GithubOAuthService.start({
              oauthAppId: String(req.body?.oauthAppId ?? ''),
              redirectUri: defaultRedirectUri(req),
              returnTo: req.body?.returnTo ? String(req.body.returnTo) : `${routePrefix(req)}${ROUTE}`,
              ownerId: (req as any).user?.id ?? null,
            });
            return res.json({ data: { authorizeUrl } });
          }

          if (method === 'syncRepositories') {
            const connectionId = String(req.body?.connectionId ?? '');
            const data = connectionId
              ? [await GithubRepositorySyncService.syncConnection(connectionId)]
              : await GithubRepositorySyncService.syncAllActiveConnections();
            return res.json({ data });
          }

          // Connections, repositories and project links are shared across platforms and are
          // managed on the core screen, not duplicated here.
          return res.status(400).json({ message: `Unknown _method: ${method ?? '(none)'}` });
        } catch (error: any) {
          const status = error instanceof GithubOAuthError ? 400 : 400;
          return res.status(status).json({ message: error?.message ?? String(error) });
        }
      },
    },
  ];

  constructor(appManager: AppManager) {
    super(appManager);
  }

  async mount(): Promise<void> {
    const configs = [generateAdminizerModelConfig(GithubOAuthApp)].map((item) => ({ appId: this.appId, item }));
    await this.appManager.collectionStorage.append('adminizerModelConfigs', configs);

    // The one thing the core cannot do with a GitHub connection by itself: renew its token and
    // re-mirror its repositories.
    registerGitConnectionAuthority(githubConnectionAuthority);
    GitSyncService.registerSyncContributor(this.appId, (project) => GithubIssueSyncService.syncProject(project));

    if (process.env.AGENTIZ_GITHUB_SYNC_ENABLED === 'true') {
      this.syncTask = cron.schedule(SYNC_CRON, () => {
        void (async () => {
          await GithubRepositorySyncService.syncAllActiveConnections();
          await GithubIssueSyncService.syncAll();
        })().catch((error) => {
          console.error(`[${APP_ID}] scheduled sync failed:`, error);
        });
      });
      console.log(`[${APP_ID}] GitHub sync scheduled: ${SYNC_CRON}`);
    } else {
      console.log(`[${APP_ID}] GitHub sync disabled (set AGENTIZ_GITHUB_SYNC_ENABLED=true to enable)`);
    }
  }

  async unmount(): Promise<void> {
    if (this.syncTask) {
      this.syncTask.stop();
      this.syncTask = null;
    }
    GitSyncService.unregisterSyncContributor(this.appId);
    unregisterGitConnectionAuthority('github');
  }
}

export default AppAgentizGithubIntegration;
