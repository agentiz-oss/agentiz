import type { RouteName, RouteParams } from './routeTree';

/**
 * The old address of every Agentiz screen and the new route it became — the table behind the
 * `302` in `legacyRedirect.ts`.
 *
 * Old addresses never simply disappear: they are in already-sent notifications
 * (`AgentNotification.metadata.url`), in the text of comments the pipeline writes, and in the
 * `urls:` of help articles. `302` is the contract, and after the port (stage 9 of
 * `.ai-notes/ui-1-sol/03-plan.md`) it is the **only** thing left at those addresses: the old
 * modules are gone, so nothing there can render any more and the redirect cannot be conditional.
 *
 * While the port was running this table carried a second half — a `ported` switch read from both
 * ends, so that an address not yet moved showed a stub pointing back at the old screen instead of
 * bouncing between the two. Every screen is moved, so the switch and the stub are gone; what is
 * left is the half that has to live forever.
 *
 * Deliberately free of imports and of `process`/`window`, like `routeTree.ts`: Vite bundles it
 * into the browser module and tsx runs the same source on the server.
 */

/** Which query parameter of the old address identifies the thing being opened. */
export type LegacyKey = 'projectId' | 'runId' | 'taskId' | 'specId' | 'workerId';

export interface LegacyScreen {
  /** The new route this address became. */
  route: RouteName;
  /** Path of the old screen, after the panel prefix (`/dashboard`). */
  path: string;
  /**
   * The query parameter that selects this entry among the ones sharing a `path`, and the value
   * the new address needs. Absent = the bare address, which is the fallback for that path.
   */
  key?: LegacyKey;
  /** Route parameters the old address does not carry because it never varied them. */
  fixed?: RouteParams;
  /** For `project.settings`, whose section is a path segment on the new address. */
  section?: string;
}

/**
 * Order matters within one `path`: the first match wins, so the entries carrying a `key` come
 * before the bare one, and the entry a `302` should land on comes before the ones that merely
 * share its old address (`/agentiz-tasks` is both the task board and the task-source settings).
 *
 * Three old addresses are deliberately **absent** and that is not an oversight — nothing here
 * could redirect them anyway, because they are not this layer's routes: `/workflows` and
 * `/workflow` belong to app-workflow (its canvas still serves them, showing every project's
 * graphs), and `/model/AgentProject` is the panel's own CRUD form, which the assistant, the
 * pickers and «Модели данных» all open. A fourth, «Обвязки и лимиты», never had an address of its
 * own: it lived inside the workers screen, and `/agentiz-workers` answers for it.
 */
export const LEGACY_SCREENS: readonly LegacyScreen[] = [
  { route: 'inbox', path: '/agentiz-interactions' },

  { route: 'project.run', path: '/agentiz-runs', key: 'runId' },
  { route: 'project.runs', path: '/agentiz-runs', key: 'projectId' },
  { route: 'runs', path: '/agentiz-runs' },

  { route: 'project.task', path: '/agentiz-tasks', key: 'taskId' },
  { route: 'project.tasks', path: '/agentiz-tasks', key: 'projectId' },

  { route: 'project.pipeline', path: '/agentiz-pipelines', key: 'specId' },
  { route: 'project.pipelines', path: '/agentiz-pipelines', key: 'projectId' },

  { route: 'worker', path: '/agentiz-workers', key: 'workerId' },
  { route: 'workers', path: '/agentiz-workers' },

  { route: 'project.repositories', path: '/agentiz-repos', key: 'projectId' },
  { route: 'integrations.gitProvider', path: '/agentiz-github', fixed: { provider: 'github' } },
  { route: 'integrations.gitProvider', path: '/agentiz-gitlab', fixed: { provider: 'gitlab' } },

  { route: 'settings.notifications', path: '/agentiz-notifications' },
  { route: 'project.settings', path: '/agentiz-members', key: 'projectId', section: 'members' },
  // `/agentiz-tasks?projectId=` redirects to the task **board** — the row above it on the same path
  // wins, and that is right: the board is what that address opened. The section keeps its row so
  // the old address of the task-source settings is still written down somewhere.
  { route: 'project.settings', path: '/agentiz-tasks', key: 'projectId', section: 'sources' },
  { route: 'project.settings', path: '/agentiz-notifications', section: 'notifications' },
] as const;

/** The entry an old request matches, or `null` when the address names nothing we moved. */
export function legacyScreenFor(path: string, query: Record<string, unknown>): LegacyScreen | null {
  return (
    LEGACY_SCREENS.find(
      (screen) =>
        screen.path === path
        && (!screen.key || (typeof query[screen.key] === 'string' && query[screen.key] !== '')),
    ) ?? null
  );
}
