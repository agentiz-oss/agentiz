import { AbstractCollectionHandler } from '@nodeknit/app-manager';
import type { AppManager, CollectionItem } from '@nodeknit/app-manager';
import { registerTaskManagerAdapter, unregisterTaskManagerAdapter } from './';
import type { TaskManagerAdapter } from './';

/** Name of the app-manager collection every remote task manager adapter is contributed to. */
export const TASK_MANAGERS_COLLECTION = 'taskManagers';

function isAdapter(item: unknown): item is TaskManagerAdapter {
  const candidate = item as TaskManagerAdapter | null;
  return Boolean(
    candidate &&
      typeof candidate.type === 'string' &&
      typeof candidate.title === 'string' &&
      typeof candidate.create === 'function',
  );
}

/**
 * Handler of the `taskManagers` collection, owned by app-agentiz.
 *
 * Any layer can declare `@Collection taskManagers: TaskManagerAdapter[]` and its platform becomes
 * selectable as a task source on any project; when that layer is unmounted its adapters are
 * dropped again. app-manager processes both orders (handler before collection and collection
 * before handler), so a contributing layer does not have to care about mount order.
 */
export class TaskManagerCollectionHandler extends AbstractCollectionHandler {
  async process(_appManager: AppManager, data: CollectionItem[]): Promise<void> {
    for (const { appId, item } of data ?? []) {
      if (!isAdapter(item)) {
        console.warn(`[app-agentiz] ${appId} contributed an invalid taskManagers item, skipped`);
        continue;
      }
      registerTaskManagerAdapter(item);
      console.log(`[app-agentiz] task manager "${item.type}" registered by ${appId}`);
    }
  }

  async unprocess(_appManager: AppManager, data: CollectionItem[]): Promise<void> {
    for (const { item } of data ?? []) {
      if (isAdapter(item)) unregisterTaskManagerAdapter(item.type);
    }
  }
}
