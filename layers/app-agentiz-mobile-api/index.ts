import { AbstractApp, AppManager, Collection } from '@nodeknit/app-manager';
import type { AdminizerRouteMiddleware, AppAdminizer } from '@nodeknit/app-adminizer';
import type { IMcpTool } from '@nodeknit/app-mcp';
import { createMobileApiRouter, MOBILE_API_BASE } from './lib/mobileApiRouter';
import { createMobileAssistantWebviewRouter } from './lib/mobileAssistantWebviewRouter';
import { closePushProviders, pushProviderSummary } from './lib/push/providers';
import { installPushSettingLogRedaction } from './lib/push/redactSettingLog';
import { forgetPushSettingStorage, pushSettingSlots, usePushSettingStorage } from './lib/push/settings';
import { pushSettingsMcpTools } from './mcp/pushSettingsTools';
import { migrations } from './migrations';
import { MobileDevice } from './models/MobileDevice';
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
   * The one table this layer owns: the push tokens of installed apps. Everything else it serves
   * still belongs to app-agentiz, app-adminizer or — for the push credentials below — app-manager.
   */
  @Collection
  models: any[] = [MobileDevice];

  /**
   * Push credentials and switches, as app-manager settings: they live in the platform's `settings`
   * table and can be changed without a deploy. Declaring the slots is what makes them storable at
   * all — app-manager refuses a key with no registered slot.
   *
   * The environment keeps priority over a stored value (app-manager's rule), which
   * `agentiz.pushSettings` reports per setting so a shadowed one is visible rather than puzzling.
   */
  @Collection
  settings: any[] = pushSettingSlots;

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
    // Before anything can store a credential: app-manager logs every setting's value on save, and a
    // service account or a `.p8` must not reach the log. See lib/push/redactSettingLog.ts.
    installPushSettingLogRedaction(this.appManager);
    // The settings collection has been processed by now, so the slots already carry whatever was
    // stored; this hands the providers the storage to read them from, and the writer its model.
    usePushSettingStorage(this.appManager);
    PushSettingsService.use(this.appManager);

    console.log(`[AppAgentizMobileApi] mobile API mounted at ${MOBILE_API_BASE}`);
    console.log(`[AppAgentizMobileApi] mobile assistant WebView mounted at ${MOBILE_API_BASE}/assistant`);
    console.log(
      MobilePushService.configured()
        ? `[AppAgentizMobileApi] push notifications enabled via ${pushProviderSummary()}`
        : `[AppAgentizMobileApi] push notifications are off (${pushProviderSummary()})`,
    );
  }

  async unmount(): Promise<void> {
    // The push provider holds a kept-alive HTTP connection; nothing else to tear down.
    closePushProviders();
    forgetPushSettingStorage();
    PushSettingsService.forget();
  }
}

export default AppAgentizMobileApi;
