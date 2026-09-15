import { AgentProject } from '../../models/AgentProject';
import { AgentRun } from '../../models/AgentRun';
import { AgentTask } from '../../models/AgentTask';
import { PipelineSpec } from '../../models/PipelineSpec';
import { legacyScreenFor, type LegacyScreen } from './legacyScreens';
import { configureRouteTree, href, type RootRouteName, type RouteParams } from './routeTree';

/**
 * `302` from an Agentiz screen's old address to its new one.
 *
 * Called from the render branch of every old route — never from the `_method` branches beside it,
 * which are the JSON API those screens still use and are not addresses at all.
 *
 * It **always** answers, and that is the difference stage 9 made. While the port was running, a
 * redirect that could not be built meant "render the old screen", which covered a deleted project,
 * a `runId` that no longer exists and the bare addresses that had no new equivalent. The old
 * modules are gone, so there is nothing left to fall back to *on the same address* — and a stale
 * link from a two-month-old notification must not become a dead end. Hence `fallback`: the route
 * of the nearest screen that always exists, which the caller names because only the caller knows
 * what its address was about. Its type is `RootRouteName` — a route with no parameters — so the
 * compiler, rather than a `500` on a stale link, is what catches a fallback that cannot be built.
 */

/** The old path this request is on, after the panel prefix. */
function pathOf(req: any): string {
  const prefix = routePrefixOf(req);
  const path = String(req.path ?? req.url ?? '').split('?')[0];
  return path.startsWith(prefix) ? path.slice(prefix.length) || '/' : path;
}

function routePrefixOf(req: any): string {
  return req?.adminizer?.config?.routePrefix ?? req?.runtime?.config?.routePrefix ?? '/dashboard';
}

/** The slug of a project id, or null when it is gone. */
async function slugOf(projectId: string | null | undefined): Promise<string | null> {
  if (!projectId) return null;
  const project = await AgentProject.findOne({ where: { id: projectId }, attributes: ['slug'] });
  return project?.slug ?? null;
}

/**
 * The new route's parameters, read out of the old query. Everything project-scoped needs a slug,
 * and only the entity itself knows which project it belongs to — which is why a run, a task and a
 * spec are each loaded rather than trusting a `projectId` that may also be in the query.
 */
async function paramsFor(screen: LegacyScreen, query: Record<string, any>): Promise<RouteParams | null> {
  const params: RouteParams = { ...(screen.fixed ?? {}) };
  if (screen.section) params.section = screen.section;

  const value = screen.key ? String(query[screen.key] ?? '') : '';
  switch (screen.key) {
    case undefined:
      return params;
    case 'workerId':
      params.workerId = value;
      return params;
    case 'projectId': {
      const slug = await slugOf(value);
      if (!slug) return null;
      params.slug = slug;
      return params;
    }
    case 'runId':
    case 'taskId':
    case 'specId': {
      const model = screen.key === 'runId' ? AgentRun : screen.key === 'taskId' ? AgentTask : PipelineSpec;
      const row: any = await (model as any).findOne({ where: { id: value }, attributes: ['id', 'projectId'] });
      const slug = await slugOf(row?.projectId);
      if (!slug) return null;
      params.slug = slug;
      params[screen.key] = value;
      return params;
    }
    default:
      return null;
  }
}

/**
 * Sends the response and never returns anything the caller has to test — `res.redirect()` answers
 * `undefined`, and a caller written as `if (moved) return moved` once fell straight through into
 * `Inertia.render` and killed the process on `ERR_HTTP_HEADERS_SENT`. The shape is therefore
 * `return legacyRedirect(req, res, '<fallback>')` as the last statement of the handler.
 */
export async function legacyRedirect(req: any, res: any, fallback: RootRouteName): Promise<void> {
  const prefix = routePrefixOf(req);
  configureRouteTree(`${prefix}/agentiz`);

  const screen = legacyScreenFor(pathOf(req), req.query ?? {});
  const params = screen ? await paramsFor(screen, req.query ?? {}) : null;

  let target: string | null = null;
  if (screen && params) {
    try {
      target = href(screen.route, params);
    } catch {
      // `href` throws on a parameter it did not get. The fallback below is the safe answer.
      target = null;
    }
  }

  res.redirect(302, target ?? href(fallback));
}
