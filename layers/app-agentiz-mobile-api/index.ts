import { AbstractApp, AppManager, Collection } from '@nodeknit/app-manager';
import type { AdminizerRouteMiddleware, AppAdminizer } from '@nodeknit/app-adminizer';
import { createMobileApiRouter, MOBILE_API_BASE } from './lib/mobileApiRouter';
import { createMobileAssistantWebviewRouter } from './lib/mobileAssistantWebviewRouter';

/**
 * Mobile API layer for Agentiz.
 *
 * Gives the mobile client a small, machine-facing JSON surface: a UserAP login exchanged for a JWT
 * bearer token, then owner-scoped read access to Agentiz projects. It owns no models and no admin
 * pages — it reuses UserAP (from app-adminizer) and AgentProject (from app-agentiz) and simply
 * exposes them, over its own router, outside the admin panel's `/dashboard` prefix.
 */
export class AppAgentizMobileApi extends AbstractApp {
  appId: string = 'app-agentiz-mobile-api';
  name: string = 'App Agentiz Mobile API';

  constructor(appManager: AppManager) {
    super(appManager);
  }

  @Collection
  adminizerMiddlewares: AdminizerRouteMiddleware[] = [{
    route: '/mobile-assistant',
    method: 'get',
    handler: async (req: any, res: any) => {
      if (!req.user) return res.sendStatus(401);
      if (!req.adminizer.accessRightsHelper.hasPermission('ai-assistant-agentiz-assistant', req.user)) return res.sendStatus(403);
      return req.Inertia.render({ component: 'module', props: { moduleComponent: '/dashboard/modules/MobileAssistant.js' } });
    },
  }];

  async mount(): Promise<void> {
    // Resolve the dependency before registering *any* HTTP route. App-manager orders this layer
    // after app-adminizer through package.json's appDependencies; failing here must not leave a
    // half-mounted mobile API whose old routes work while the WebView router is absent.
    const adminizerApp = this.appManager.appStorage.get('app-adminizer')?.appInstance as AppAdminizer | undefined;
    if (!adminizerApp) {
      console.error('[AppAgentizMobileApi] app-adminizer is unavailable; mobile API was not mounted');
      throw new Error('app-adminizer must be mounted before app-agentiz-mobile-api');
    }
    // Root app, not the Adminizer prefix: mobile clients authenticate with their own bearer token,
    // not admin sessions. Same placement as the Worker API.
    this.appManager.app.use(MOBILE_API_BASE, createMobileApiRouter(this.appManager.sequelize));
    this.appManager.app.use(
      `${MOBILE_API_BASE}/assistant`,
      createMobileAssistantWebviewRouter(this.appManager.sequelize, adminizerApp.adminizer),
    );
    console.log(`[AppAgentizMobileApi] mobile API mounted at ${MOBILE_API_BASE}`);
    console.log(`[AppAgentizMobileApi] mobile assistant WebView mounted at ${MOBILE_API_BASE}/assistant`);
  }

  async unmount(): Promise<void> {
    // Nothing to tear down: no timers, no DB writes, no owned models.
  }
}

export default AppAgentizMobileApi;
