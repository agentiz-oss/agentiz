import { AbstractApp, AppManager } from '@nodeknit/app-manager';
import { createMobileApiRouter, MOBILE_API_BASE } from './lib/mobileApiRouter';

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

  async mount(): Promise<void> {
    // Root app, not the Adminizer prefix: mobile clients authenticate with their own bearer token,
    // not admin sessions. Same placement as the Worker API.
    this.appManager.app.use(MOBILE_API_BASE, createMobileApiRouter(this.appManager.sequelize));
    console.log(`[AppAgentizMobileApi] mobile API mounted at ${MOBILE_API_BASE}`);
  }

  async unmount(): Promise<void> {
    // Nothing to tear down: no timers, no DB writes, no owned models.
  }
}

export default AppAgentizMobileApi;
