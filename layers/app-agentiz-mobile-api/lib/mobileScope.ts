/**
 * What a phone is allowed to see — the mobile API's half of the project boundary.
 *
 * There is no second rule here: both functions delegate to `app-agentiz/lib/access/projectAccess`,
 * so the app and the panel answer the same question the same way. What this module adds is the
 * mobile *shape* of the answer — a list of ids for the queries that filter by project, and a 404
 * (never a 403) for a foreign id, which is the standing convention of every endpoint in this
 * layer: the API must not confirm that somebody else's task exists.
 *
 * The access graph does **not** cover any of this. It lives inside adminizer's `DataAccessor`,
 * which serves the panel's generic CRUD and its pickers; the mobile API reads Sequelize directly.
 * "В панели не видно" therefore says nothing about the app, and these calls are what make the two
 * agree.
 *
 * The caller is an Adminizer user id, not a loaded user row, so there is no administrator flag and
 * no bypass token to read: a mobile caller is judged on ownership and membership alone. That is a
 * subset of what the same person gets in the panel, never a superset.
 */

import { can, projectIdsForUser } from '../../app-agentiz/lib/access/projectAccess';
import { PROJECT_TOKENS } from '../../app-agentiz/lib/access/tokens';
import { MobileAuthError } from '../services/MobileAuthService';

/**
 * Projects the caller may look at. Empty means "nothing to look at", never "everything" — every
 * caller filters by the returned list and returns early when it is empty.
 */
export async function visibleProjectIds(
  userId: number | string,
  token: string = PROJECT_TOKENS.read,
): Promise<string[]> {
  return projectIdsForUser(userId, token);
}

/** True when the caller may act on this project. */
export async function canInProject(
  projectId: string,
  userId: number | string,
  token: string = PROJECT_TOKENS.read,
): Promise<boolean> {
  return can(userId, projectId, token);
}

/**
 * The guard every "…ById" method starts with. `notFound` is the message of the *thing* being
 * fetched, not of the project, because that is what the caller asked for and what the answer has
 * to look like: a foreign proposal id and a deleted one are indistinguishable on purpose.
 */
export async function requireProjectAccess(
  projectId: string,
  userId: number | string,
  notFound: string,
  token: string = PROJECT_TOKENS.read,
): Promise<void> {
  if (await canInProject(projectId, userId, token)) return;
  throw new MobileAuthError(404, notFound);
}
