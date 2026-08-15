import { AbstractCollectionHandler } from '@nodeknit/app-manager';
import type { AppManager, CollectionItem } from '@nodeknit/app-manager';
import { registerInteractionNotifier, unregisterInteractionNotifier } from './interactionNotifiers';
import type { InteractionNotifier } from './interactionNotifiers';

/** Name of the app-manager collection every "an agent is asking" listener is contributed to. */
export const INTERACTION_NOTIFIERS_COLLECTION = 'interactionNotifiers';

function isNotifier(item: unknown): item is InteractionNotifier {
  const candidate = item as InteractionNotifier | null;
  return Boolean(candidate && typeof candidate.id === 'string' && typeof candidate.notifyCreated === 'function');
}

/**
 * Handler of the `interactionNotifiers` collection, owned by app-agentiz.
 *
 * Any layer can declare `@Collection interactionNotifiers: InteractionNotifier[]` and start hearing
 * about pending human input; unmounting that layer takes its notifier back out. app-manager
 * processes both mount orders, so the contributing layer does not have to care whether app-agentiz
 * came first.
 */
export class InteractionNotifierCollectionHandler extends AbstractCollectionHandler {
  async process(_appManager: AppManager, data: CollectionItem[]): Promise<void> {
    for (const { appId, item } of data ?? []) {
      if (!isNotifier(item)) {
        console.warn(`[app-agentiz] ${appId} contributed an invalid interactionNotifiers item, skipped`);
        continue;
      }
      registerInteractionNotifier(item);
      console.log(`[app-agentiz] interaction notifier "${item.id}" registered by ${appId}`);
    }
  }

  async unprocess(_appManager: AppManager, data: CollectionItem[]): Promise<void> {
    for (const { item } of data ?? []) {
      if (isNotifier(item)) unregisterInteractionNotifier(item.id);
    }
  }
}
