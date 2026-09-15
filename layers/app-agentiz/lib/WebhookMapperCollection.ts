import { AbstractCollectionHandler } from '@nodeknit/app-manager';
import type { AppManager, CollectionItem } from '@nodeknit/app-manager';
import { registerWebhookMapper, unregisterWebhookMapper } from './webhooks';
import type { WebhookMapper } from './webhooks';

/** Name of the app-manager collection every webhook mapper is contributed to. */
export const WEBHOOK_MAPPERS_COLLECTION = 'webhookMappers';

function isMapper(item: unknown): item is WebhookMapper {
  const candidate = item as WebhookMapper | null;
  return Boolean(candidate && typeof candidate.kind === 'string' && typeof candidate.handle === 'function');
}

/**
 * Handler of the `webhookMappers` collection, owned by app-agentiz.
 *
 * The core owns the registry rather than the receiving layer so that the two directions of this
 * seam meet in one place: a provider layer contributes a mapper here, and the layer that actually
 * serves the HTTP endpoint reads the same registry. Either one being absent is a supported state —
 * with no receiver nothing is served, with no mapper an endpoint of that kind answers 404.
 */
export class WebhookMapperCollectionHandler extends AbstractCollectionHandler {
  async process(_appManager: AppManager, data: CollectionItem[]): Promise<void> {
    for (const { appId, item } of data ?? []) {
      if (!isMapper(item)) {
        console.warn(`[app-agentiz] ${appId} contributed an invalid webhookMappers item, skipped`);
        continue;
      }
      registerWebhookMapper(item);
      console.log(`[app-agentiz] webhook mapper "${item.kind}" registered by ${appId}`);
    }
  }

  async unprocess(_appManager: AppManager, data: CollectionItem[]): Promise<void> {
    for (const { item } of data ?? []) {
      if (isMapper(item)) unregisterWebhookMapper(item.kind);
    }
  }
}
