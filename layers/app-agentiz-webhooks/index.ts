import { AbstractApp, AppManager, Collection } from '@nodeknit/app-manager';
import type { Migration } from '@nodeknit/app-manager';
import { agentizModelConfig } from '../app-agentiz/lib/panel/modelConfigs';
import { registerWebhookHost, unregisterWebhookHost } from '../app-agentiz/lib/webhooks';
import type { WebhookHost } from '../app-agentiz/lib/webhooks';
import { migrations } from './migrations';
import { createWebhookRouter } from './lib/webhookRouter';
import { AgentWebhookDelivery } from './models/AgentWebhookDelivery';
import { AgentWebhookEndpoint } from './models/AgentWebhookEndpoint';

const APP_ID = 'app-agentiz-webhooks';

/**
 * Where an external sender reaches us. Versioned in the path, because this URL ends up configured
 * inside somebody else's system and cannot be changed by a deploy.
 */
export const WEBHOOK_API_BASE = '/api/agentiz/hooks/v1';

/**
 * The receiving half of inbound webhooks.
 *
 * It knows nothing about what any delivery *means* — that is a mapper's business, contributed
 * through the core's `webhookMappers` collection by whichever layer understands the sender. This
 * layer owns exactly three things: a public URL with a raw body, the check that the sender is who
 * it claims to be, and a journal of every delivery including the ones that were refused.
 *
 * It is optional. With this layer absent, a provider integration simply installs no hooks and its
 * periodic poll carries everything — which is also the only thing a deployment behind no public
 * address could do.
 */
export class AppAgentizWebhooks extends AbstractApp {
  appId: string = APP_ID;
  name: string = 'App Agentiz Webhooks';

  @Collection
  migrations: Migration[] = migrations.umzug;

  @Collection
  models: any[] = [AgentWebhookEndpoint, AgentWebhookDelivery];

  constructor(appManager: AppManager) {
    super(appManager);
  }

  /**
   * Public origin of this server.
   *
   * From configuration only, never from a request: a hook URL is written into GitHub once and has
   * to keep working, so deriving it from whichever request happened to trigger the install would
   * bake a proxy's idea of the host into a third party's configuration. No `AGENTIZ_PUBLIC_URL`
   * means this deployment cannot host webhooks, which the host reports as `null` rather than
   * guessing.
   */
  private static origin(): string | null {
    const configured = process.env.AGENTIZ_PUBLIC_URL ?? process.env.PUBLIC_URL;
    return configured ? configured.replace(/\/+$/, '') : null;
  }

  private readonly host: WebhookHost = {
    ensureEndpoint: async (input) => {
      const origin = AppAgentizWebhooks.origin();
      if (!origin) throw new Error('AGENTIZ_PUBLIC_URL не задан — этому развёртыванию некуда принимать вебхуки');
      const [endpoint] = await AgentWebhookEndpoint.findOrCreate({
        where: { ownerKey: input.ownerKey },
        defaults: {
          kind: input.kind,
          ownerKey: input.ownerKey,
          projectId: input.projectId ?? null,
          config: input.config ?? null,
          secretHash: null,
          isActive: true,
        },
      });
      // Re-linking a repository must not leave a disabled endpoint behind, and a mapper renamed in
      // a release must not leave rows pointing at a kind nobody serves.
      if (!endpoint.isActive || endpoint.kind !== input.kind) {
        await endpoint.update({ isActive: true, kind: input.kind });
      }
      return { id: endpoint.id, url: `${origin}${WEBHOOK_API_BASE}/${endpoint.id}` };
    },
    removeEndpoint: async (ownerKey) => {
      const endpoint = await AgentWebhookEndpoint.findOne({ where: { ownerKey } });
      if (!endpoint) return;
      // Deleted, not merely deactivated: the deliveries cascade off it in the journal's own
      // retention, and an endpoint nobody owns is a URL that answers 404 for a reason nobody can
      // look up.
      await endpoint.destroy();
    },
    endpointUrl: (endpointId) => {
      const origin = AppAgentizWebhooks.origin();
      return origin ? `${origin}${WEBHOOK_API_BASE}/${endpointId}` : null;
    },
  };

  async mount(): Promise<void> {
    const configs = [
      agentizModelConfig(AgentWebhookEndpoint),
      agentizModelConfig(AgentWebhookDelivery),
    ].map((item) => ({ appId: this.appId, item }));
    await this.appManager.collectionStorage.append('adminizerModelConfigs', configs);

    // Root app, not the Adminizer prefix: the sender is an external system with its own secret,
    // not an admin session. Same placement as the Worker API and the mobile API.
    this.appManager.app.use(WEBHOOK_API_BASE, createWebhookRouter());
    registerWebhookHost(this.host);

    const origin = AppAgentizWebhooks.origin();
    console.log(
      origin
        ? `[${APP_ID}] webhook receiver mounted at ${origin}${WEBHOOK_API_BASE}`
        : `[${APP_ID}] webhook receiver mounted at ${WEBHOOK_API_BASE};`
          + ' AGENTIZ_PUBLIC_URL не задан, поэтому хуки никуда не ставятся и всё работает на опросе',
    );
  }

  async unmount(): Promise<void> {
    unregisterWebhookHost();
  }
}

export default AppAgentizWebhooks;
