/**
 * The two lines every Agentiz panel endpoint starts with.
 *
 * `adminizerMiddlewares` are mounted **before** Adminizer's own auth and permission policies, so
 * for a JSON endpoint under `/dashboard` there is no check at all unless the handler makes one.
 * That was tolerable while every such route was owner-blind; it stops being tolerable the moment
 * a project has members, because "не участник" and "участник другого проекта" have to mean
 * something.
 *
 * `requirePanelUser` is authentication only — it answers "есть ли вообще сессия". `guardProject`
 * is the authorisation half and delegates the decision to `projectAccess.can()`, so the panel and
 * the mobile API give the same answer to the same question.
 */

import { assertCan, createAccessCache, ProjectAccessError } from './projectAccess';
import type { AccessActor, AccessCache } from './projectAccess';

/** Whoever is driving the panel, in the shape `projectAccess` understands. */
export function panelActor(req: any): AccessActor {
  const user = req.session?.UserAP ?? req.user ?? null;
  if (!user) return null;
  // A session copy may carry the groups as a plain array while `req.user` carries model instances;
  // both answer `.tokens`, and neither is guaranteed to be there — an actor without groups is
  // judged on ownership and membership alone, which is a subset of what they really have.
  return user as AccessActor;
}

/**
 * Panel session check. Answers 401 and returns false when there is none. A panel started with
 * `auth.enable === false` has no sessions at all and is let through — that switch is the operator
 * saying the whole panel is open.
 */
export function requirePanelUser(req: any, res: any): boolean {
  if (req.adminizer?.config?.auth?.enable === false) return true;
  if (req.session?.UserAP?.id || typeof req.user?.id === 'number') return true;
  res.status(401).json({ message: 'Sign in to the admin panel first' });
  return false;
}

/** A cache with the lifetime of this request, so one handler asking three questions costs one. */
export function requestAccessCache(req: any): AccessCache {
  if (!req.__agentizAccessCache) req.__agentizAccessCache = createAccessCache();
  return req.__agentizAccessCache as AccessCache;
}

/**
 * A **global** token — one that means the same thing everywhere and therefore lives in the
 * person's ordinary groups, not in a project role: the worker fleet, git connections, the
 * installation-wide notification defaults.
 *
 * Read straight off the session's groups rather than through `checkPermission`, because the
 * dispatcher runs before Adminizer's policies and `req.user` here is a session copy, not the model
 * instance that helper expects. The comparison is case-insensitive on purpose: a token stored as
 * `Agentiz-Workers-Manage` would pass the access graph and fail an exact match, and this side of
 * the check must not be the one that disagrees.
 */
export function hasGlobalToken(req: any, token: string): boolean {
  const actor = panelActor(req) as any;
  if (actor?.isAdministrator) return true;
  const wanted = token.toLowerCase();
  const groups: Array<{ tokens?: unknown[] }> = actor?.groups ?? [];
  return groups.some((group) => (group?.tokens ?? []).some((grant: any) =>
    (typeof grant === 'string' && grant.toLowerCase() === wanted)
    || grant?.tokenId?.toLowerCase?.() === wanted));
}

/** Session + global token, answering 401/403 itself. The counterpart of `guardProject`. */
export function guardGlobal(req: any, res: any, token: string, message: string): boolean {
  if (!requirePanelUser(req, res)) return false;
  if (req.adminizer?.config?.auth?.enable === false) return true;
  if (hasGlobalToken(req, token)) return true;
  res.status(403).json({ message });
  return false;
}

/**
 * Session + project right, as one call. Returns false having already answered — 401 with no
 * session, 404 when the project may not even be read (a 403 there would confirm it exists), 403
 * when it may be read but not acted on.
 */
export async function guardProject(req: any, res: any, projectId: string, token: string): Promise<boolean> {
  if (!requirePanelUser(req, res)) return false;
  if (req.adminizer?.config?.auth?.enable === false) return true;
  if (!projectId) {
    res.status(400).json({ message: 'projectId is required' });
    return false;
  }
  try {
    await assertCan(panelActor(req), projectId, token, requestAccessCache(req));
    return true;
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      res.status(error.status).json({ message: error.message });
      return false;
    }
    res.status(500).json({ message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
