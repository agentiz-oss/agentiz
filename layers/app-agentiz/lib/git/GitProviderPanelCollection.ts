import { AbstractCollectionHandler } from '@nodeknit/app-manager';
import type { AppManager, CollectionItem } from '@nodeknit/app-manager';
import { registerGitProviderPanel, unregisterGitProviderPanel } from './providerPanels';
import type { GitProviderPanel } from './providerPanels';

/** Name of the app-manager collection every provider layer describes its panel through. */
export const GIT_PROVIDER_PANELS_COLLECTION = 'gitProviderPanels';

function isPanel(item: unknown): item is GitProviderPanel {
  const candidate = item as GitProviderPanel | null;
  return Boolean(
    candidate
    && typeof candidate.provider === 'string'
    && typeof candidate.title === 'string'
    && typeof candidate.apiRoute === 'string'
    && Array.isArray(candidate.appFields),
  );
}

/**
 * Handler of the `gitProviderPanels` collection, owned by app-agentiz.
 *
 * The sibling of `GitProviderCollectionHandler` and `GitConnectionAuthority`, for the third thing
 * a platform layer owns: how its half of the shared screen reads. Contributing it is what puts a
 * card on «Git-провайдеры»; unmounting the layer takes the card away and leaves the connections it
 * authorized alone, because those are core rows and a screen that hid them would hide the only
 * evidence that an account was ever connected.
 *
 * Both mount orders work (handler first or collection first) — app-manager replays the collection
 * for a handler registered later, exactly as it does for `gitProviders`.
 */
export class GitProviderPanelCollectionHandler extends AbstractCollectionHandler {
  async process(_appManager: AppManager, data: CollectionItem[]): Promise<void> {
    for (const { appId, item } of data ?? []) {
      if (!isPanel(item)) {
        console.warn(`[app-agentiz] ${appId} contributed an invalid gitProviderPanels item, skipped`);
        continue;
      }
      registerGitProviderPanel(item);
      console.log(`[app-agentiz] git provider panel "${item.provider}" registered by ${appId}`);
    }
  }

  async unprocess(_appManager: AppManager, data: CollectionItem[]): Promise<void> {
    for (const { item } of data ?? []) {
      if (isPanel(item)) unregisterGitProviderPanel(item.provider);
    }
  }
}
