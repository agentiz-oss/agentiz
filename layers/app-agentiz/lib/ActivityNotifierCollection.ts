import { AbstractCollectionHandler } from '@nodeknit/app-manager';
import type { AppManager, CollectionItem } from '@nodeknit/app-manager';
import { registerActivityNotifier, unregisterActivityNotifier } from './activityNotifiers';
import type { ActivityNotifier } from './activityNotifiers';

/** Name of the app-manager collection every activity listener is contributed to. */
export const ACTIVITY_NOTIFIERS_COLLECTION = 'activityNotifiers';

function isNotifier(item: unknown): item is ActivityNotifier {
  const candidate = item as ActivityNotifier | null;
  return Boolean(candidate && typeof candidate.id === 'string'
    && typeof candidate.channel === 'string' && typeof candidate.notify === 'function');
}

/**
 * Handler of the `activityNotifiers` collection, owned by app-agentiz.
 *
 * Any layer can declare `@Collection activityNotifiers: ActivityNotifier[]` and start hearing
 * about feed events; unmounting that layer takes its notifier back out. app-manager processes both
 * mount orders, so the contributing layer does not have to care whether app-agentiz came first.
 */
export class ActivityNotifierCollectionHandler extends AbstractCollectionHandler {
  async process(_appManager: AppManager, data: CollectionItem[]): Promise<void> {
    for (const { appId, item } of data ?? []) {
      if (!isNotifier(item)) {
        console.warn(`[app-agentiz] ${appId} contributed an invalid activityNotifiers item, skipped`);
        continue;
      }
      registerActivityNotifier(item);
      console.log(`[app-agentiz] activity notifier "${item.id}" (channel ${item.channel}) registered by ${appId}`);
    }
  }

  async unprocess(_appManager: AppManager, data: CollectionItem[]): Promise<void> {
    for (const { item } of data ?? []) {
      if (isNotifier(item)) unregisterActivityNotifier(item.id);
    }
  }
}
