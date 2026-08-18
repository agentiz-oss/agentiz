import { AbstractCollectionHandler } from '@nodeknit/app-manager';
import type { AppManager, CollectionItem } from '@nodeknit/app-manager';
import {
  harnessLimitProviderFor,
  registerHarnessLimitProvider,
  unregisterHarnessLimitProvider,
} from './harnessLimits';
import type { HarnessLimitProvider } from './harnessLimits';

/** Name of the app-manager collection provider layers contribute their limit knowledge to. */
export const HARNESS_LIMIT_PROVIDERS_COLLECTION = 'harnessLimitProviders';

function isProvider(item: unknown): item is HarnessLimitProvider {
  const candidate = item as HarnessLimitProvider | null;
  return Boolean(candidate
    && typeof candidate.id === 'string'
    && typeof candidate.handles === 'function'
    && typeof candidate.declareWindows === 'function'
    && typeof candidate.classifyFailure === 'function');
}

/**
 * Handler of the `harnessLimitProviders` collection, owned by app-agentiz.
 *
 * Any layer can declare `@Collection harnessLimitProviders: HarnessLimitProvider[]` and start
 * classifying that harness's failures and usage reports; unmounting the layer takes the knowledge
 * back out and the core falls back to manual mode for those keys.
 */
export class HarnessLimitProviderCollectionHandler extends AbstractCollectionHandler {
  async process(_appManager: AppManager, data: CollectionItem[]): Promise<void> {
    for (const { appId, item } of data ?? []) {
      if (!isProvider(item)) {
        console.warn(`[app-agentiz] ${appId} contributed an invalid harnessLimitProviders item, skipped`);
        continue;
      }
      // One harness key — one provider: the first registered wins, a duplicate is only reported.
      const declared = item.declareWindows().map((window) => window.key).join(', ');
      for (const key of ['claude', 'codex']) {
        const existing = item.handles(key) ? harnessLimitProviderFor(key) : null;
        if (existing && existing.id !== item.id) {
          console.warn(`[app-agentiz] harness limit provider "${item.id}" also handles "${key}", already served by "${existing.id}" — first one wins`);
        }
      }
      registerHarnessLimitProvider(item);
      console.log(`[app-agentiz] harness limit provider "${item.id}" registered by ${appId} (windows: ${declared})`);
    }
  }

  async unprocess(_appManager: AppManager, data: CollectionItem[]): Promise<void> {
    for (const { item } of data ?? []) {
      if (isProvider(item)) unregisterHarnessLimitProvider(item.id);
    }
  }
}
