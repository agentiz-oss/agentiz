import { TaskManagerProvider } from './TaskManagerProvider';
import type {
  CommentResult,
  ListTaskManagerTasksParams,
  NormalizedExternalComment,
  NormalizedExternalTask,
  TaskManagerAdapter,
  TaskManagerConfig,
  TaskManagerConfigField,
  TaskManagerCredentials,
} from './TaskManagerProvider';

export { TaskManagerProvider };
export type {
  CommentResult,
  ListTaskManagerTasksParams,
  NormalizedExternalComment,
  NormalizedExternalTask,
  TaskManagerAdapter,
  TaskManagerConfig,
  TaskManagerConfigField,
  TaskManagerCredentials,
};

/**
 * type -> adapter, filled by the `taskManagers` collection handler while apps are mounted.
 *
 * The map is parked on a global symbol rather than kept as plain module state: under tsx the same
 * file can end up instantiated twice (once through the ESM graph, once through CJS), and a
 * module-level Map would then split in two — adapters registered by the handler would be invisible
 * to createTaskManager(). Same rule as lib/git/index.ts, see docs/app-layers/pitfalls.md.
 */
const ADAPTERS_KEY = Symbol.for('agentiz.taskManagerAdapters');
const globalScope = globalThis as unknown as Record<symbol, Map<string, TaskManagerAdapter> | undefined>;
const taskManagerAdapters: Map<string, TaskManagerAdapter> =
  globalScope[ADAPTERS_KEY] ?? (globalScope[ADAPTERS_KEY] = new Map());

export function registerTaskManagerAdapter(adapter: TaskManagerAdapter): void {
  taskManagerAdapters.set(adapter.type, adapter);
}

export function unregisterTaskManagerAdapter(type: string): void {
  taskManagerAdapters.delete(type);
}

export function getTaskManagerAdapter(type: string): TaskManagerAdapter | undefined {
  return taskManagerAdapters.get(type);
}

/** Task managers usable right now — i.e. whose layers are mounted. */
export function listTaskManagerTypes(): string[] {
  return [...taskManagerAdapters.keys()];
}

/** What the admin UI needs to render the "add a task source" form. Never includes credentials. */
export function describeTaskManagers(): Array<{
  type: string;
  title: string;
  description: string | null;
  configFields: TaskManagerConfigField[];
  supportsWriteback: boolean;
  supportsComments: boolean;
}> {
  return [...taskManagerAdapters.values()].map((adapter) => ({
    type: adapter.type,
    title: adapter.title,
    description: adapter.description ?? null,
    configFields: adapter.configFields ?? [],
    supportsWriteback: Boolean(adapter.supportsWriteback),
    supportsComments: Boolean(adapter.supportsComments),
  }));
}

/**
 * Origin of a task created inside Agentiz rather than mirrored from anywhere. It is not an
 * adapter and never will be — hence the explicit constant instead of a missing-adapter case.
 */
export const LOCAL_TASK_SOURCE_TYPE = 'local';

/** Human label for a task's origin, falling back to the raw type when the layer is not mounted. */
export function taskManagerTitle(type: string | null | undefined): string {
  if (!type || type === LOCAL_TASK_SOURCE_TYPE) return 'вручную';
  return taskManagerAdapters.get(type)?.title ?? type;
}

/**
 * True when the task's origin can still be talked to. Locally created tasks answer `true`: they
 * have no remote system, so there is nothing to warn about.
 */
export function isTaskSourceAvailable(type: string | null | undefined): boolean {
  if (!type || type === LOCAL_TASK_SOURCE_TYPE) return true;
  return taskManagerAdapters.has(type);
}

export function createTaskManager(
  type: string,
  config: TaskManagerConfig,
  credentials: TaskManagerCredentials,
): TaskManagerProvider {
  const adapter = taskManagerAdapters.get(type);
  if (!adapter) {
    const available = listTaskManagerTypes().join(', ') || 'none';
    throw new Error(
      `No task manager adapter for "${type}": the layer providing it is not mounted (available: ${available})`,
    );
  }
  return adapter.create(config, credentials);
}
