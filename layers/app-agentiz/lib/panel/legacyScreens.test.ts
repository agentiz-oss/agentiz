import { describe, expect, it } from 'vitest';
import { LEGACY_SCREENS, legacyScreenFor } from './legacyScreens';
import {
  configureRouteTree,
  href,
  matchRoute,
  PROJECT_SETTINGS_SECTIONS,
  ROOT_ROUTES,
  ROUTES,
} from './routeTree';

/**
 * What is left of the port once every screen has moved: the old addresses, and the fact that each
 * one still names a screen that exists. Those addresses are in notifications sent months ago and
 * in the text of comments the pipeline writes, so the `302` is a contract — and the way it breaks
 * quietly is not a missing row but a lookup landing on the *wrong* one, because several rows share
 * a path and several share a route.
 */
describe('legacy screens', () => {
  configureRouteTree('/dashboard/agentiz');

  it('names a route that exists', () => {
    for (const screen of LEGACY_SCREENS) {
      const params = { slug: 'billing', runId: 'r1', taskId: 't1', specId: 's1', workerId: 'w1', provider: 'github', section: screen.section ?? 'members' };
      const address = href(screen.route, params);
      expect(matchRoute(address.slice('/dashboard/agentiz'.length))?.name).toBe(screen.route);
    }
  });

  it('finds every row back from its own address', () => {
    for (const screen of LEGACY_SCREENS) {
      const query: Record<string, string> = screen.key ? { [screen.key]: 'x' } : {};
      // Several rows share a path, so this only has to be the *first* row on it — but it must be
      // a row of that path, never `null`.
      expect(legacyScreenFor(screen.path, query)?.path).toBe(screen.path);
    }
  });

  it('prefers the entity over the board on a shared path', () => {
    expect(legacyScreenFor('/agentiz-runs', { runId: 'r1', projectId: 'p1' })?.route).toBe('project.run');
    expect(legacyScreenFor('/agentiz-runs', { projectId: 'p1' })?.route).toBe('project.runs');
    expect(legacyScreenFor('/agentiz-runs', {})?.route).toBe('runs');
    // `/agentiz-tasks?projectId=` is both the task board and the task-source settings; the board wins.
    expect(legacyScreenFor('/agentiz-tasks', { projectId: 'p1' })?.route).toBe('project.tasks');
    // An empty value is not a value: `?runId=` opens the board, not a run with no id.
    expect(legacyScreenFor('/agentiz-runs', { runId: '' })?.route).toBe('runs');
  });

  it('never redirects an address that is not ours', () => {
    // app-workflow's canvas still serves both of these, showing every project's graphs.
    expect(legacyScreenFor('/workflows', {})).toBeNull();
    expect(legacyScreenFor('/workflow', { id: 'f1' })).toBeNull();
    // The panel's own CRUD form: a `302` from here would take the model editor away from the
    // assistant, the pickers and «Модели данных» as well as from a person.
    expect(legacyScreenFor('/model/AgentProject', {})).toBeNull();
    // Ours, but the harness screen never had an address of its own — the workers row answers here.
    expect(legacyScreenFor('/agentiz-workers', {})?.route).toBe('workers');
  });

  it('keeps two providers apart on one route', () => {
    // Two rows differing only in `fixed.provider`; matching on the route name alone would send
    // every provider's address to GitHub.
    expect(
      LEGACY_SCREENS.filter((screen) => screen.route === 'integrations.gitProvider')
        .map((screen) => [screen.fixed?.provider, screen.path]),
    ).toEqual([['github', '/agentiz-github'], ['gitlab', '/agentiz-gitlab']]);
    expect(legacyScreenFor('/agentiz-gitlab', {})?.fixed?.provider).toBe('gitlab');
    expect(legacyScreenFor('/agentiz-github', {})?.fixed?.provider).toBe('github');
  });

  it('keeps the project settings sections apart', () => {
    // Three rows on one route, differing only in `section` — matching on the route name alone
    // would send every section's lookup to «Участники». «Настройки проекта» has no row on
    // purpose: its old address is the panel's own CRUD form, checked above.
    const sections = LEGACY_SCREENS.filter((screen) => screen.route === 'project.settings');
    expect(sections.map((screen) => [screen.section, screen.path])).toEqual([
      ['members', '/agentiz-members'],
      ['sources', '/agentiz-tasks'],
      ['notifications', '/agentiz-notifications'],
    ]);
    // Every one of them names a section the route tree actually accepts.
    for (const screen of sections) {
      expect(PROJECT_SETTINGS_SECTIONS).toContain(screen.section as any);
    }
  });

  /**
   * The fallback of a `302` that cannot be built — a deleted project, a `runId` that no longer
   * exists, an address that never had a new equivalent. `href` throws on a parameter it did not
   * get, so a fallback naming a route with a `:param` would answer `500` to exactly the stale
   * link this mechanism exists for. `RootRouteName` is what stops that at compile time, and this
   * is what stops the list itself from drifting away from the tree.
   */
  it('offers every parameterless route as a fallback, and nothing else', () => {
    const parameterless = ROUTES.filter(([, pattern]) => !pattern.includes(':')).map(([name]) => name);
    expect([...ROOT_ROUTES].sort()).toEqual([...parameterless].sort());
    for (const name of ROOT_ROUTES) expect(() => href(name)).not.toThrow();
  });
});
