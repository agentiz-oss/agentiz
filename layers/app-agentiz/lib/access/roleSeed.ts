/**
 * Putting the role groups and the owners' membership rows into the database.
 *
 * Two jobs, both idempotent, both run from `AppAgentiz.mount()`:
 *
 * 1. **Sow the role groups.** Every preset in `tokens.ts` becomes an ordinary `GroupAP` if a group
 *    of that name does not exist yet. An existing group is never touched — its token list is the
 *    operator's, and re-writing it on every boot would silently undo edits made in the panel.
 * 2. **Give every project's owner a membership row.** Not a convenience: the graph resolves the
 *    root through membership rows only and does not read `ownerId` at all, so a project without
 *    one is invisible to everybody but an administrator — a state that cannot be repaired from the
 *    panel, because the members screen itself sits behind `project-read`.
 *
 * Why here and not in the migration: migrations do not run in development
 * (`MigrationHandler` skips unless `NODE_ENV=production` / `USE_MIGRATIONS=true`), and an access
 * boundary that exists on only one of the two setups is worse than none.
 *
 * The backfill deliberately fires only for projects with **no membership rows at all**. Re-seeding
 * the owner unconditionally would resurrect a row somebody removed on purpose; restricting it to
 * empty projects means it only ever fixes the one state nobody can see or fix — and that is also
 * the state §7.4 of the plan describes.
 */

import type { ModelStatic, Model, Sequelize, Transaction } from 'sequelize';
import { AgentProject } from '../../models/AgentProject';
import { AgentProjectMember } from '../../models/AgentProjectMember';
import { ownerRolePreset, seededGroups } from './tokens';

function groupModel(): ModelStatic<Model> | null {
  const sequelize = AgentProjectMember.sequelize as Sequelize | undefined;
  if (!sequelize || !sequelize.isDefined('GroupAP')) return null;
  return sequelize.model('GroupAP') as ModelStatic<Model>;
}

/** Cached per process: the group ids never change once seeded, and the hook runs per project. */
const OWNER_GROUP_KEY = Symbol.for('agentiz.access.ownerRoleGroupId');

function ownerGroupHolder(): Record<symbol, number | null | undefined> {
  return globalThis as unknown as Record<symbol, number | null | undefined>;
}

export function forgetOwnerRoleGroup(): void {
  ownerGroupHolder()[OWNER_GROUP_KEY] = undefined;
}

/** Id of `Agentiz · Владелец`, or null where there is no panel (unit tests, worker-only process). */
export async function ownerRoleGroupId(): Promise<number | null> {
  const holder = ownerGroupHolder();
  if (holder[OWNER_GROUP_KEY] !== undefined) return holder[OWNER_GROUP_KEY] ?? null;

  const Group = groupModel();
  if (!Group) return null;
  const found = await Group.findOne({ where: { name: ownerRolePreset().name } as any });
  const id = found ? Number((found.get({ plain: true }) as any).id) : null;
  holder[OWNER_GROUP_KEY] = id;
  return id;
}

/** Creates the missing role groups; returns how many were created. */
export async function seedAgentizAccessGroups(): Promise<number> {
  const Group = groupModel();
  if (!Group) return 0;

  let created = 0;
  for (const preset of seededGroups()) {
    const existing = await Group.findOne({ where: { name: preset.name } as any });
    if (existing) continue;
    await Group.create({ name: preset.name, description: preset.description, tokens: preset.tokens } as any);
    created += 1;
  }
  if (created > 0) forgetOwnerRoleGroup();
  return created;
}

/**
 * The owner's membership row for one project. Called by the `@AfterCreate` hook on `AgentProject`
 * with the creating transaction, so the project and the row that makes it visible are committed
 * together — between two separate commits sits a project nobody but an administrator can see.
 *
 * Returns false and stays quiet when there is nothing to do: no owner, no panel (so no `GroupAP`),
 * or the role group has not been sown yet. None of those is an error a `create` should fail on,
 * and the boot-time backfill picks the project up afterwards.
 */
export async function ensureOwnerMembership(
  project: { id: string; ownerId: number | null },
  transaction?: Transaction,
): Promise<boolean> {
  if (project.ownerId === null || project.ownerId === undefined) return false;
  const groupId = await ownerRoleGroupId();
  if (groupId === null) return false;

  const existing = await AgentProjectMember.findOne({
    where: { projectId: project.id, userId: Number(project.ownerId), groupId },
    transaction,
  });
  if (existing) return false;

  await AgentProjectMember.create(
    { projectId: project.id, userId: Number(project.ownerId), groupId, grantedByUserId: null },
    { transaction },
  );
  return true;
}

/** Owner rows for projects that have no membership at all; returns how many were written. */
export async function backfillOwnerMemberships(): Promise<number> {
  const groupId = await ownerRoleGroupId();
  if (groupId === null) return 0;

  const projects = await AgentProject.findAll({ attributes: ['id', 'ownerId'] });
  if (projects.length === 0) return 0;

  const withMembers = new Set(
    (await AgentProjectMember.findAll({ attributes: ['projectId'] })).map((row) => row.projectId),
  );

  let written = 0;
  for (const project of projects) {
    if (withMembers.has(project.id)) continue;
    if (await ensureOwnerMembership({ id: project.id, ownerId: project.ownerId ?? null })) written += 1;
  }
  return written;
}

/** Both halves, in the only order that works. Safe to call on every boot. */
export async function installAgentizAccessRoles(): Promise<{ groupsCreated: number; ownersLinked: number }> {
  const groupsCreated = await seedAgentizAccessGroups();
  const ownersLinked = await backfillOwnerMemberships();
  return { groupsCreated, ownersLinked };
}
