import { hasPanelSession } from '../access/panelGuard';
import { buildAgentizBrand, buildAgentizMenu, buildAgentizSections } from './menu';
import { configureRouteTree, href } from './routeTree';

/**
 * One shell for the whole panel: Agentiz is *the* context, not a second one beside the panel's.
 *
 * Adminizer draws its own sidebar on its own pages and hands us `menu` / `menuSections` only as
 * page props we override under `/agentiz` (`render.ts`). Left at that, a person meets **two**
 * panels: the one after login — `/dashboard`, adminizer's welcome text, its models in the sidebar,
 * an «Agentiz» row to click — and ours, with a completely different sidebar, one click later.
 * Every visit to a user's form or to the knowledge base switched back. The mockup has one: the
 * first screen after login is the overview, and the sidebar is the same on every page.
 *
 * Two things, both in this one middleware, which the app-adminizer dispatcher runs on every
 * request under the panel prefix, before any route:
 *
 * 1. **The panel's root is the overview.** `GET /dashboard` with a session is a `302` to
 *    `href('overview')`. Only with a session: without one it falls through to adminizer's own
 *    handler, whose `requireAuthUI` sends the person to the login form with `redirectTo=/dashboard/`
 *    — and after the login that address lands here again, now with a session. That is the entire
 *    post-login flow, and nothing in adminizer's login controller had to learn our address.
 *
 * 2. **Our sidebar on every page.** For a page request anywhere else in the panel — a model's CRUD,
 *    users, groups, the knowledge base — the global-mode menu and the project switcher are put into
 *    the **shared** props through `req.Inertia.shareProps`. Adminizer's `bindInertia` middleware
 *    has already shared its own by then (it is mounted before the dispatcher), and `shareProps`
 *    merges, so ours replace the panel's for this request. The pages of that sidebar are the same
 *    ones `restOfPanel()` appends below our sections, which is what makes it a shell rather than a
 *    trap. Under `/agentiz` nothing is shared: `render.ts` builds the context-dependent menu as page
 *    props itself, and building it twice would double every query behind the badges.
 *
 * What a page request is: `GET`, no `_method` (the JSON API of our screens rides the same
 * addresses), and an `Accept` naming html or the `X-Inertia` header. The dispatcher hands every
 * request under the prefix through here — uploads, log polling, the worker's own API is elsewhere —
 * so anything that is not a page has to cost nothing, and the answer to a failure is the panel's
 * own sidebar, never an error: decoration must not take the page down.
 */
export async function panelShell(req: any, res: any, next: (err?: unknown) => void): Promise<void> {
  try {
    if (!isPageRequest(req) || !hasPanelSession(req)) return next();

    const prefix = routePrefixOf(req);
    const base = `${prefix}/agentiz`;
    configureRouteTree(base);

    const path = pathOf(req);
    if (path === prefix) {
      res.redirect(302, href('overview'));
      return;
    }
    if (path === base || path.startsWith(`${base}/`)) return next();
    if (typeof req.Inertia?.shareProps !== 'function') return next();

    const [menu, brand] = await Promise.all([buildAgentizMenu(req, null), buildAgentizBrand(req, null)]);
    req.Inertia.shareProps({ menu, menuSections: buildAgentizSections(req), ...brand });
    return next();
  } catch (error) {
    // The dispatcher's own try/catch does not see a rejected promise, and a thrown error here would
    // be an unhandled rejection with the request left hanging. The page gets the panel's sidebar.
    if (!res.headersSent) return next();
  }
}

/**
 * Sends a browser without a session to the login form, remembering where it was going — the same
 * address and query adminizer's own `requireAuthUI` uses (`helpers/inertiaAutHelper.js`, a subpath
 * the package does not export). A bookmarked Agentiz screen opened after the session expired used
 * to answer `401 {"message": ...}` as raw JSON; the login form then brings the person back to it.
 */
export function redirectToLogin(req: any, res: any): void {
  const prefix = routePrefixOf(req);
  const back = encodeURIComponent(String(req.originalUrl ?? req.url ?? `${prefix}/agentiz`));
  res.redirect(302, `${prefix}/model/User/login?redirectTo=${back}`);
}

/** A browser asking for a page, as opposed to a script asking for data on the same address. */
export function isPageRequest(req: any): boolean {
  if (String(req.method ?? 'GET').toUpperCase() !== 'GET') return false;
  if (req.query && typeof req.query._method === 'string') return false;
  if (req.headers?.['x-inertia']) return true;
  return String(req.headers?.accept ?? '').includes('text/html');
}

function routePrefixOf(req: any): string {
  return req?.adminizer?.config?.routePrefix ?? req?.runtime?.config?.routePrefix ?? '/dashboard';
}

/** The request path without a trailing slash — the root arrives as both `/dashboard` and `/dashboard/`. */
function pathOf(req: any): string {
  const path = String(req.path ?? req.url ?? '').split('?')[0];
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}
