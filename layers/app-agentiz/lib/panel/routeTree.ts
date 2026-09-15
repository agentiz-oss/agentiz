/**
 * The address tree of the Agentiz panel, and the only place that knows it.
 *
 * One registered route (`/agentiz`) serves all of it: the app-adminizer dispatcher matches a
 * **prefix**, not an express pattern (`local_modules/app-adminizer/src/AppAdminizer.ts`), so
 * `:param` in `route` does nothing and `req.params` is empty. The path is parsed here instead.
 *
 * Both sides import this file — the server to decide what to render, the module to build every
 * link it draws. That is the point: a sidebar, a breadcrumb and a button that each spell the same
 * address by hand start disagreeing the first time one of them is edited.
 *
 * Deliberately free of imports, `process` and `window`: it is bundled into the browser module by
 * Vite and executed under tsx on the server from the same source.
 */

export type RouteName =
  | 'overview'
  | 'inbox'
  | 'runs'
  | 'projects'
  | 'project.overview'
  | 'project.tasks'
  | 'project.task'
  | 'project.runs'
  | 'project.run'
  | 'project.pipelines'
  | 'project.pipeline'
  | 'project.workflows'
  | 'project.workflow'
  | 'project.repositories'
  | 'project.settings'
  | 'workers'
  | 'worker'
  | 'harnesses'
  | 'integrations.git'
  | 'integrations.gitProvider'
  | 'settings.notifications'
  | 'admin.data';

export type RouteParams = Record<string, string>;

export interface RouteMatch {
  name: RouteName;
  params: RouteParams;
}

/**
 * Patterns are written the way they read in the address bar; `:name` is one segment. Order here is
 * documentation only — matching sorts by specificity, so a literal segment always beats a
 * parameter at the same position and `/workers/new` could be added later without moving anything.
 */
export const ROUTES: ReadonlyArray<readonly [RouteName, string]> = [
  ['overview', '/'],
  ['inbox', '/inbox'],
  ['runs', '/runs'],
  ['projects', '/projects'],
  ['project.overview', '/projects/:slug'],
  ['project.tasks', '/projects/:slug/tasks'],
  ['project.task', '/projects/:slug/tasks/:taskId'],
  ['project.runs', '/projects/:slug/runs'],
  ['project.run', '/projects/:slug/runs/:runId'],
  ['project.pipelines', '/projects/:slug/pipelines'],
  ['project.pipeline', '/projects/:slug/pipelines/:specId'],
  ['project.workflows', '/projects/:slug/workflows'],
  ['project.workflow', '/projects/:slug/workflows/:workflowId'],
  ['project.repositories', '/projects/:slug/repositories'],
  ['project.settings', '/projects/:slug/settings/:section'],
  ['workers', '/workers'],
  ['worker', '/workers/:workerId'],
  ['harnesses', '/harnesses'],
  ['integrations.git', '/integrations/git'],
  ['integrations.gitProvider', '/integrations/git/:provider'],
  ['settings.notifications', '/settings/notifications'],
  ['admin.data', '/admin/data'],
] as const;

/**
 * The routes whose pattern carries no `:param`, so `href(name)` alone always resolves.
 *
 * Written out rather than derived because a union cannot be filtered at type level, and it is
 * worth the duplication: a `302` that has nowhere else to go lands on one of these
 * (`legacyRedirect.ts`), and `href` throwing there would answer `500` to a stale link from a
 * two-month-old notification. `legacyScreens.test.ts` checks the list against `ROUTES`.
 */
export type RootRouteName =
  | 'overview'
  | 'inbox'
  | 'runs'
  | 'projects'
  | 'workers'
  | 'harnesses'
  | 'integrations.git'
  | 'settings.notifications'
  | 'admin.data';

export const ROOT_ROUTES: readonly RootRouteName[] = [
  'overview', 'inbox', 'runs', 'projects', 'workers', 'harnesses',
  'integrations.git', 'settings.notifications', 'admin.data',
] as const;

/** The sections a project's settings screen is allowed to open on. */
export const PROJECT_SETTINGS_SECTIONS = ['members', 'sources', 'notifications', 'general'] as const;
export type ProjectSettingsSection = (typeof PROJECT_SETTINGS_SECTIONS)[number];

/**
 * What each of them is called, in one place. Three surfaces print these words — the sidebar
 * (`menu.ts`), the breadcrumb (`render.ts`) and the screen's own heading (`modules/lib/settings.tsx`)
 * — and a section named two ways reads as two different screens.
 */
export const PROJECT_SETTINGS_TITLES: Record<ProjectSettingsSection, string> = {
  members: 'Участники',
  sources: 'Источники задач',
  notifications: 'Уведомления',
  general: 'Настройки проекта',
};

function segments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** Literal segments first, so `/integrations/git` wins over a hypothetical `/:a/:b`. */
const COMPILED = ROUTES.map(([name, pattern]) => ({
  name,
  pattern,
  parts: segments(pattern),
})).sort((a, b) => {
  const literals = (parts: string[]) => parts.filter((p) => !p.startsWith(':')).length;
  return literals(b.parts) - literals(a.parts);
});

/**
 * `path` is the part **after** the panel prefix and `/agentiz` — the caller strips those, because
 * only the caller knows the configured `routePrefix`. A query string is ignored: filters and tabs
 * live in the query on purpose and never choose the screen.
 */
export function matchRoute(path: string): RouteMatch | null {
  const parts = segments((path.split('?')[0] ?? '').split('#')[0] ?? '');
  for (const route of COMPILED) {
    if (route.parts.length !== parts.length) continue;
    const params: RouteParams = {};
    let ok = true;
    for (let i = 0; i < route.parts.length; i += 1) {
      const expected = route.parts[i];
      const actual = parts[i];
      if (expected.startsWith(':')) {
        if (!actual) { ok = false; break; }
        params[expected.slice(1)] = decodeURIComponent(actual);
      } else if (expected !== actual) {
        ok = false;
        break;
      }
    }
    if (ok) return { name: route.name, params };
  }
  return null;
}

/**
 * Where the tree is mounted, e.g. `/dashboard/agentiz`. Set once at startup from the only source
 * that knows it: `adminizer.config.routePrefix` on the server, `window.routePrefix` in the browser.
 */
let base = '/dashboard/agentiz';

export function configureRouteTree(panelBase: string): void {
  base = panelBase.replace(/\/$/, '');
}

export function routeBase(): string {
  return base;
}

/** The address of a screen. The one way a link is spelled anywhere in the panel. */
export function href(name: RouteName, params: RouteParams = {}, query?: Record<string, string | number | undefined | null>): string {
  const entry = ROUTES.find(([routeName]) => routeName === name);
  if (!entry) throw new Error(`Unknown Agentiz route: ${name}`);
  const path = segments(entry[1])
    .map((part) => {
      if (!part.startsWith(':')) return part;
      const value = params[part.slice(1)];
      if (value === undefined) throw new Error(`Route ${name} needs the "${part.slice(1)}" parameter`);
      return encodeURIComponent(value);
    })
    .join('/');
  const search = query
    ? Object.entries(query)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join('&')
    : '';
  return `${base}${path ? `/${path}` : ''}${search ? `?${search}` : ''}`;
}

/** True while the address is inside a project — what flips the sidebar from global to project. */
export function projectSlugOf(match: RouteMatch | null): string | null {
  return match?.params.slug ?? null;
}
