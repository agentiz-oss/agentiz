import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { AgentActivity } from '../../models/AgentActivity';

/**
 * The addressees of an **installation** event — something about the deployment itself rather than
 * about any project (a new server version). They are the Adminizer administrators, read from the
 * `UserAP.isAdministrator` flag and nothing else: no project role and no global token stands in for
 * it, because a role is about projects and this event has none.
 *
 * `UserAP` is reached through the shared Sequelize registry the way `AgentProject` reaches it. In a
 * process without the panel (unit tests, a worker-only build) the model is not defined, and the
 * answer is "nobody" — an installation event is then journalled and delivered to no one, which is
 * what an installation with no administrators should get anyway.
 */
function userModel(): ModelStatic<Model> | null {
  const sequelize = AgentActivity.sequelize as Sequelize | undefined;
  if (!sequelize || !sequelize.isDefined('UserAP')) return null;
  return sequelize.model('UserAP') as ModelStatic<Model>;
}

function liveAdministrator(row: Model): boolean {
  const user = row.get({ plain: true }) as { isAdministrator?: unknown; isDeleted?: unknown };
  return Boolean(user.isAdministrator) && user.isDeleted !== true;
}

/** Ids of every administrator not marked deleted. */
export async function administratorIds(): Promise<number[]> {
  const User = userModel();
  if (!User) return [];
  const rows = await User.findAll({ where: { isAdministrator: true } as any });
  return rows
    .filter(liveAdministrator)
    .map((row) => Number(row.get('id')))
    .filter((id) => Number.isFinite(id));
}

/**
 * For a caller that has only an id — the mobile API — and has to decide whether installation rows
 * belong in what it shows. A loaded panel user already carries the flag; read it there instead.
 */
export async function isAdministratorId(userId: number | string): Promise<boolean> {
  const id = Number(userId);
  const User = userModel();
  if (!User || !Number.isFinite(id)) return false;
  const row = await User.findByPk(id);
  return row !== null && liveAdministrator(row);
}
