/**
 * "Может ли этот человек сделать это в этом проекте" — the one place that answers it.
 *
 * Adminizer answers a different question and answers it elsewhere. `checkPermission` reads
 * `user.groups`, i.e. **global** groups, and role groups are by construction not among those
 * (that is the whole point of the design — a role must mean something in one project and nothing
 * anywhere else). The access graph answers the mirror question — "какие *строки* видно" — and
 * answers it inside `DataAccessor`, handing nothing back out. So the project-scoped check is ours,
 * and it lives here, in five functions, so that nothing else in the layer ever reads
 * `AgentProjectMember` or `GroupAP.tokens` by hand.
 *
 * What `can()` says yes to, in order: an administrator, the graph's bypass token
 * (`agentiz-project-admin`, support), the project's own `ownerId`, and finally a membership row
 * whose role group carries the token. The owner shortcut is a convenience *here*; it is not what
 * makes their records visible in the panel — the graph reads membership rows only, which is why
 * every owner also gets a membership row (see `roleSeed.ts` and the `@AfterCreate` on
 * `AgentProject`).
 *
 * Caching is per request, never global: adminizer does the same with `RecordAccessCache` and for
 * the same reason — a membership that went stale is a worse outcome than a query saved. Callers
 * that answer one HTTP request and ask several questions pass a `createAccessCache()`; callers
 * that ask once pass nothing.
 */

import { parseGroupPermissionGrant } from 'adminizer';
import type { Sequelize, ModelStatic, Model } from 'sequelize';
import { AgentProject } from '../../models/AgentProject';
import { AgentProjectMember } from '../../models/AgentProjectMember';
import { GLOBAL_TOKENS, PROJECT_TOKENS } from './tokens';

/**
 * Copy of `grantsToken` from `adminizer/src/lib/access-graph/shared.ts`. Not imported: that module
 * is outside the package's `exports` map (which allows `.`, `./lib/DataAccessor`, `./ui/*` and
 * `./adminizer-module` only), so a deep import fails to resolve at all. `parseGroupPermissionGrant`
 * is the one piece of it the public entry point does export, and the rest is three lines.
 *
 * Keep it identical, and re-read it when adminizer is upgraded: this is the single place where the
 * graph's logic is duplicated, and a divergence would show up as neither an error nor a failing
 * test — only as a wrong answer to "есть ли право".
 *
 * `tokenId` is expected lowercase (that is what `registerToken` and `parseGroupPermissionGrant`
 * produce); every caller below lowercases its argument.
 */
function grantsToken(grants: unknown[], tokenId: string): boolean {
  return grants.some((grant) =>
    (typeof grant === 'string' && grant.toLowerCase() === tokenId) ||
    parseGroupPermissionGrant(grant)?.tokenId === tokenId);
}

/**
 * Whatever the caller has of the person. A panel request carries the whole `UserAP` row with its
 * groups populated; the mobile API and the worker API carry an id and nothing else. Both are
 * accepted, and the difference is exactly one capability: without groups there is no
 * administrator flag and no bypass token to read, so an id-only actor is judged on ownership and
 * membership alone — which is a subset, never a superset, of what the same person would get with
 * their groups loaded.
 */
export type AccessActor =
  | number
  | string
  | {
      id: number | string | null;
      isAdministrator?: boolean | null;
      groups?: Array<{ tokens?: unknown[] | null }> | null;
      [key: string]: unknown;
    }
  | null
  | undefined;

/** Carries an HTTP status so a route can answer without deciding the wording twice. */
export class ProjectAccessError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface AccessCache {
  tokens: Map<string, Promise<Set<string>>>;
  projects: Map<string, Promise<string[]>>;
}

/** A cache with the lifetime of one request. Pass it along, never store it. */
export function createAccessCache(): AccessCache {
  return { tokens: new Map(), projects: new Map() };
}

function actorId(actor: AccessActor): number | null {
  if (actor === null || actor === undefined) return null;
  const raw = typeof actor === 'object' ? actor.id : actor;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

function isAdministrator(actor: AccessActor): boolean {
  return typeof actor === 'object' && actor !== null && Boolean(actor.isAdministrator);
}

/** Global-group grants — the only thing role groups are deliberately absent from. */
function hasGlobalToken(actor: AccessActor, token: string): boolean {
  if (typeof actor !== 'object' || actor === null) return false;
  const wanted = token.toLowerCase();
  return (actor.groups ?? []).some((group) => grantsToken((group?.tokens ?? []) as unknown[], wanted));
}

/** Administrator or support: sees and does everything, membership or not. */
function bypasses(actor: AccessActor): boolean {
  return isAdministrator(actor) || hasGlobalToken(actor, GLOBAL_TOKENS.projectAdmin);
}

/**
 * The `GroupAP` model, reached through the shared Sequelize registry the way `AgentProject`
 * reaches `UserAP`. Absent outside the panel (unit tests, a worker-only process), and then a role
 * group simply grants nothing — ownership still answers.
 */
function groupModel(): ModelStatic<Model> | null {
  const sequelize = AgentProjectMember.sequelize as Sequelize | undefined;
  if (!sequelize || !sequelize.isDefined('GroupAP')) return null;
  return sequelize.model('GroupAP') as ModelStatic<Model>;
}

function tokensOfGroups(rows: Array<{ tokens?: unknown }>): Set<string> {
  const tokens = new Set<string>();
  for (const row of rows) {
    for (const grant of ((row as any).tokens ?? []) as unknown[]) {
      if (typeof grant === 'string') tokens.add(grant.toLowerCase());
      else {
        const parsed = parseGroupPermissionGrant(grant);
        if (parsed) tokens.add(parsed.tokenId);
      }
    }
  }
  return tokens;
}

/**
 * Every token this person holds **in this project**, from the role groups of their membership
 * rows. Nothing global is folded in: the answer to "что он может здесь" must differ between two
 * projects for the same person, which is exactly what makes this table worth having.
 *
 * Two queries: the membership rows (0–1 for most people, on the `(projectId, userId)` index) and
 * their groups in one `IN`. That order is copied from `membershipTargetIds` inside adminizer —
 * doing it the other way round costs one query per membership.
 */
export async function tokensInProject(
  actor: AccessActor,
  projectId: string,
  cache?: AccessCache,
): Promise<Set<string>> {
  const userId = actorId(actor);
  if (userId === null || !projectId) return new Set();

  const key = `${projectId}:${userId}`;
  const cached = cache?.tokens.get(key);
  if (cached) return cached;

  const promise = (async () => {
    const rows = await AgentProjectMember.findAll({
      where: { projectId, userId },
      attributes: ['groupId'],
    });
    const groupIds = [...new Set(rows.map((row) => row.groupId).filter((id) => id !== null && id !== undefined))];
    if (groupIds.length === 0) return new Set<string>();

    const Group = groupModel();
    if (!Group) return new Set<string>();
    const groups = await Group.findAll({ where: { id: groupIds as any } });
    return tokensOfGroups(groups.map((group) => group.get({ plain: true }) as any));
  })();

  cache?.tokens.set(key, promise);
  return promise;
}

/**
 * The decision. `token` may be any project token (`agentiz-*`) or, when a caller wants to mirror
 * the graph, a model CRUD token — the comparison is the same string comparison either way.
 */
export async function can(
  actor: AccessActor,
  projectId: string,
  token: string,
  cache?: AccessCache,
): Promise<boolean> {
  if (bypasses(actor)) return true;
  const userId = actorId(actor);
  if (userId === null || !projectId) return false;

  const project = await AgentProject.findByPk(projectId, { attributes: ['id', 'ownerId'] });
  if (!project) return false;
  if (project.ownerId !== null && Number(project.ownerId) === userId) return true;

  return (await tokensInProject(actor, projectId, cache)).has(token.toLowerCase());
}

/**
 * `can()` with the answer a route should give. A person who cannot even read the project is told
 * it does not exist — 403 on a project you may not see leaks that it does; 403 is reserved for
 * "виден, но нельзя", which is a real and actionable distinction for the person reading it.
 */
export async function assertCan(
  actor: AccessActor,
  projectId: string,
  token: string,
  cache?: AccessCache,
): Promise<void> {
  if (await can(actor, projectId, token, cache)) return;
  if (token !== PROJECT_TOKENS.read && (await can(actor, projectId, PROJECT_TOKENS.read, cache))) {
    throw new ProjectAccessError(403, 'Недостаточно прав в этом проекте');
  }
  throw new ProjectAccessError(404, 'Проект не найден');
}

/**
 * "Мои проекты" — the single definition of it, used by the mobile API, by every list endpoint and
 * by the members screen. With a `token`, only the projects where that token actually applies.
 *
 * Deliberately a union of ownership and membership: the owner shortcut in `can()` would otherwise
 * disagree with the list, and a project whose owner row went missing would vanish from its own
 * owner's app while still answering their direct requests.
 */
export async function projectIdsForUser(
  actor: AccessActor,
  token?: string,
  cache?: AccessCache,
): Promise<string[]> {
  const userId = actorId(actor);
  const key = `${userId ?? 'anon'}:${token ?? '*'}`;
  const cached = cache?.projects.get(key);
  if (cached) return cached;

  const promise = (async () => {
    if (bypasses(actor)) {
      const all = await AgentProject.findAll({ attributes: ['id'] });
      return all.map((project) => project.id);
    }
    if (userId === null) return [];

    const [owned, rows] = await Promise.all([
      AgentProject.findAll({ where: { ownerId: userId as any }, attributes: ['id'] }),
      AgentProjectMember.findAll({ where: { userId }, attributes: ['projectId', 'groupId'] }),
    ]);

    const ids = new Set(owned.map((project) => project.id));
    if (rows.length > 0) {
      let allowed = rows;
      if (token) {
        // Same order of operations as adminizer's `membershipTargetIds`: rows first, then their
        // groups in one query. A person in a hundred projects must not cost a hundred queries.
        const Group = groupModel();
        const groupIds = [...new Set(rows.map((row) => row.groupId))];
        const groups = Group ? await Group.findAll({ where: { id: groupIds as any } }) : [];
        const wanted = token.toLowerCase();
        const granting = new Set(
          groups
            .map((group) => group.get({ plain: true }) as any)
            .filter((group) => grantsToken((group.tokens ?? []) as unknown[], wanted))
            .map((group) => Number(group.id)),
        );
        allowed = rows.filter((row) => granting.has(Number(row.groupId)));
      }
      for (const row of allowed) ids.add(row.projectId);
    }
    return [...ids];
  })();

  cache?.projects.set(key, promise);
  return promise;
}

/**
 * Who is told when something happens in this project — the replacement for "шлём владельцу".
 *
 * With a `token`, only the people for whom the event is a decision rather than news: an approval
 * request goes to `recipientsForProject(projectId, 'agentiz-approval-decide')` and to nobody else.
 * The owner is always included; they are the person the project answers to whether or not their
 * role group survived an edit.
 */
export async function recipientsForProject(projectId: string, token?: string): Promise<number[]> {
  if (!projectId) return [];
  const project = await AgentProject.findByPk(projectId, { attributes: ['id', 'ownerId'] });
  if (!project) return [];

  const recipients = new Set<number>();
  if (project.ownerId !== null && project.ownerId !== undefined) recipients.add(Number(project.ownerId));

  const rows = await AgentProjectMember.findAll({ where: { projectId }, attributes: ['userId', 'groupId'] });
  if (rows.length > 0) {
    let allowed = rows;
    if (token) {
      const Group = groupModel();
      const groupIds = [...new Set(rows.map((row) => row.groupId))];
      const groups = Group ? await Group.findAll({ where: { id: groupIds as any } }) : [];
      const wanted = token.toLowerCase();
      const granting = new Set(
        groups
          .map((group) => group.get({ plain: true }) as any)
          .filter((group) => grantsToken((group.tokens ?? []) as unknown[], wanted))
          .map((group) => Number(group.id)),
      );
      allowed = rows.filter((row) => granting.has(Number(row.groupId)));
    }
    for (const row of allowed) recipients.add(Number(row.userId));
  }

  return [...recipients].filter((id) => Number.isFinite(id));
}
