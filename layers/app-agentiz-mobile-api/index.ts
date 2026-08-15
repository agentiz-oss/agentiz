import { AbstractApp, AppManager, Collection } from '@nodeknit/app-manager';
import type { AdminizerRouteMiddleware, AppAdminizer } from '@nodeknit/app-adminizer';
import type { IMcpTool } from '@nodeknit/app-mcp';
import { createMobileApiRouter, MOBILE_API_BASE } from './lib/mobileApiRouter';
import { createMobileAssistantWebviewRouter } from './lib/mobileAssistantWebviewRouter';
import { closePushProviders, pushProviderSummary } from './lib/push/providers';
import { clearPushSettingOverlay } from './lib/push/settings';
import { pushSettingsMcpTools } from './mcp/pushSettingsTools';
import { migrations } from './migrations';
import { MobileDevice } from './models/MobileDevice';
import { MobilePushSetting } from './models/MobilePushSetting';
import { MobilePushService } from './services/MobilePushService';
import { PushSettingsService } from './services/PushSettingsService';
import type { InteractionNotifier } from '../app-agentiz/lib/interactionNotifiers';

/**
 * Mobile API layer for Agentiz.
 *
 * Gives the mobile client a small, machine-facing JSON surface: a UserAP login exchanged for a JWT
 * bearer token, then owner-scoped read access to Agentiz projects. It reuses UserAP (from
 * app-adminizer) and AgentProject (from app-agentiz) and simply exposes them, over its own router,
 * outside the admin panel's `/dashboard` prefix.
 *
 * The single thing it owns is `MobileDevice` — the push tokens of installed apps — because a device
 * is a property of this API's clients, not of the pipeline domain.
 */
export class AppAgentizMobileApi extends AbstractApp {
  appId: string = 'app-agentiz-mobile-api';
  name: string = 'App Agentiz Mobile API';

  constructor(appManager: AppManager) {
    super(appManager);
  }

  /**
   * The two tables this layer owns: the push tokens of installed apps, and the push credentials
   * themselves. Everything else it serves still belongs to app-agentiz or app-adminizer.
   */
  @Collection
  models: any[] = [MobileDevice, MobilePushSetting];

  @Collection
  migrations: any[] = migrations.umzug;

  /**
   * Turns a new agent question into a push on the project owner's phones. app-agentiz owns the
   * `interactionNotifiers` collection and emits the event; the credentials, the device rows and the
   * push providers live here.
   */
  @Collection
  interactionNotifiers: InteractionNotifier[] = [new MobilePushService()];

  /**
   * Push configuration over MCP: what is set and where it came from, and a way to install a
   * credential without editing `.env` and restarting the process.
   */
  @Collection
  mcpTools: IMcpTool[] = pushSettingsMcpTools;

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
    // Before anything reports on push: settings stored in the database override the environment,
    // and until they are loaded the summary below would describe the wrong configuration.
    await PushSettingsService.load();

    console.log(`[AppAgentizMobileApi] mobile API mounted at ${MOBILE_API_BASE}`);
    console.log(`[AppAgentizMobileApi] mobile assistant WebView mounted at ${MOBILE_API_BASE}/assistant`);
    console.log(
      MobilePushService.configured()
        ? `[AppAgentizMobileApi] push notifications enabled via ${pushProviderSummary()}`
        : `[AppAgentizMobileApi] push notifications are off (${pushProviderSummary()})`,
    );
  }

  async unmount(): Promise<void> {
    // The APNs provider keeps one long-lived HTTP/2 session to Apple; nothing else to tear down.
    closePushProviders();
    clearPushSettingOverlay();
  }
}

export default AppAgentizMobileApi;
