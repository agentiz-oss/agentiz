import { AbstractCollectionHandler } from '@nodeknit/app-manager';
import type { AppManager, CollectionItem } from '@nodeknit/app-manager';
import { registerGitProviderAdapter, unregisterGitProviderAdapter } from './';
import type { GitProviderAdapter } from './';

/** Name of the app-manager collection every Git hosting adapter is contributed to. */
export const GIT_PROVIDERS_COLLECTION = 'gitProviders';

function isAdapter(item: unknown): item is GitProviderAdapter {
  const candidate = item as GitProviderAdapter | null;
  return Boolean(candidate && typeof candidate.type === 'string' && typeof candidate.create === 'function');
}

/**
 * Handler of the `gitProviders` collection, owned by app-agentiz.
 *
 * Any layer can declare `@Collection gitProviders: GitProviderAdapter[]` and its platforms become
 * available to createGitProvider(); when that layer is unmounted its adapters are dropped again.
 * app-manager processes both orders (handler before collection and collection before handler), so
 * the contributing layer does not have to care about mount order.
 */
export class GitProviderCollectionHandler extends AbstractCollectionHandler {
  async process(_appManager: AppManager, data: CollectionItem[]): Promise<void> {
    for (const { appId, item } of data ?? []) {
      if (!isAdapter(item)) {
        console.warn(`[app-agentiz] ${appId} contributed an invalid gitProviders item, skipped`);
        continue;
      }
      registerGitProviderAdapter(item);
      console.log(`[app-agentiz] git provider "${item.type}" registered by ${appId}`);
    }
  }

  async unprocess(_appManager: AppManager, data: CollectionItem[]): Promise<void> {
    for (const { item } of data ?? []) {
      if (isAdapter(item)) unregisterGitProviderAdapter(item.type);
    }
  }
}
