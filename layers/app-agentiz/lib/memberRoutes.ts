import type { AdminizerRouteMiddleware } from '@nodeknit/app-adminizer';
import type { ModelStatic, Model, Sequelize } from 'sequelize';
import { Op } from 'sequelize';
import { AgentProject } from '../models/AgentProject';
import { AgentProjectMember } from '../models/AgentProjectMember';
import { guardProject, panelActor, requirePanelUser } from './access/panelGuard';
import { can } from './access/projectAccess';
import { PROJECT_TOKENS, ROLE_PRESETS, ownerRolePreset } from './access/tokens';

/**
 * The members screen's HTTP surface: `/dashboard/agentiz-members`.
 *
 * Scope is deliberately three verbs — add somebody, change their role, take them out — and this
 * file is the **only** writer of `AgentProjectMember`. Nothing here creates, edits or deletes a
 * group or its tokens: handing out project access must never be able to change what a role means
 * for every other project, or to take away somebody's access to an unrelated part of the panel.
 * A role that does not exist yet is created once, in the panel's own group editor, and is then
 * available everywhere.
 *
 * Reads need `agentiz-project-read` (a member may see who else is in the project); every write
 * needs `agentiz-project-members`, which the Мейнтейнер step of the ladder is the first to carry.
 */

const ROUTE = '/agentiz-members';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function systemModel(name: string): ModelStatic<Model> | null {
  const sequelize = AgentProjectMember.sequelize as Sequelize | undefined;
  if (!sequelize || !sequelize.isDefined(name)) return null;
  return sequelize.model(name) as ModelStatic<Model>;
}

function plain(record: Model | null | undefined): Record<string, unknown> | null {
  return record ? (record.get({ plain: true }) as Record<string, unknown>) : null;
}

/** Only what a person-picker needs; a member list is not a way to read the user table. */
function publicUser(user: Record<string, unknown> | null) {
  if (!user) return null;
  return {
    id: user.id,
    login: user.login ?? null,
    fullName: user.fullName ?? null,
    email: user.email ?? null,
    avatar: user.avatar ?? null,
  };
}

const tokensOf = (group: Record<string, unknown> | null): string[] =>
  Array.isArray(group?.tokens)
    ? (group!.tokens as unknown[])
        .map((grant) => (typeof grant === 'string' ? grant : (grant as any)?.tokenId))
        .filter((token): token is string => typeof token === 'string')
        .map((token) => token.toLowerCase())
    : [];

/**
 * Which rung of the ladder a group is, by comparing token sets. A group whose set matches no
 * preset is labelled «Особая роль» rather than guessed at — and because each preset contains the
 * previous one, "matches" can only be the exact set, never a prefix.
 */
function presetKeyOf(group: Record<string, unknown> | null): string | null {
  const tokens = new Set(tokensOf(group));
  for (const preset of ROLE_PRESETS) {
    if (preset.tokens.length !== tokens.size) continue;
    if (preset.tokens.every((token) => tokens.has(token))) return preset.key;
  }
  return null;
}

async function loadGroups(): Promise<Record<string, unknown>[]> {
  const Group = systemModel('GroupAP');
  if (!Group) return [];
  const groups = await Group.findAll({ order: [['name', 'ASC']] });
  return groups.map((group) => plain(group)!).filter(Boolean);
}

async function loadUsers(ids: number[]): Promise<Map<number, Record<string, unknown>>> {
  const User = systemModel('UserAP');
  if (!User || ids.length === 0) return new Map();
  const users = await User.findAll({ where: { id: ids as any } });
  return new Map(users.map((user) => {
    const row = plain(user)!;
    return [Number(row.id), row];
  }));
}

export const memberRoutes: AdminizerRouteMiddleware[] = [
  {
    route: ROUTE,
    method: 'get',
    handler: async (req, res) => {
      const method = str(req.query?._method);

      if (method === 'list') {
        const projectId = str(req.query?.projectId);
        if (!await guardProject(req, res, projectId, PROJECT_TOKENS.read)) return undefined;

        const project = await AgentProject.findByPk(projectId);
        if (!project) return res.status(404).json({ message: 'Проект не найден' });

        const rows = await AgentProjectMember.findAll({ where: { projectId }, order: [['createdAt', 'ASC']] });
        const groups = await loadGroups();
        const groupById = new Map(groups.map((group) => [Number(group.id), group]));
        const users = await loadUsers([
          ...new Set([
            ...rows.map((row) => Number(row.userId)),
            ...rows.map((row) => Number(row.grantedByUserId)).filter(Number.isFinite),
            ...(project.ownerId !== null ? [Number(project.ownerId)] : []),
          ]),
        ]);

        const canManage = await can(panelActor(req), projectId, PROJECT_TOKENS.projectMembers);

        return res.json({
          data: rows.map((row) => {
            const group = groupById.get(Number(row.groupId)) ?? null;
            return {
              id: row.id,
              userId: row.userId,
              user: publicUser(users.get(Number(row.userId)) ?? null),
              groupId: row.groupId,
              groupName: (group?.name as string) ?? null,
              presetKey: presetKeyOf(group),
              tokens: tokensOf(group),
              grantedBy: publicUser(users.get(Number(row.grantedByUserId)) ?? null),
              createdAt: row.createdAt,
              // The owner's row is what makes their own project visible to them; taking it away
              // is the one removal nobody can undo from this screen.
              isOwner: project.ownerId !== null && Number(project.ownerId) === Number(row.userId),
            };
          }),
          meta: {
            canManage,
            owner: publicUser(project.ownerId !== null ? users.get(Number(project.ownerId)) ?? null : null),
            ownerRoleName: ownerRolePreset().name,
            presets: ROLE_PRESETS.map(({ key, name, description }) => ({ key, name, description })),
            roles: groups.map((group) => ({
              id: group.id,
              name: group.name,
              description: group.description ?? null,
              presetKey: presetKeyOf(group),
            })),
          },
        });
      }

      if (method === 'candidates') {
        const projectId = str(req.query?.projectId);
        if (!await guardProject(req, res, projectId, PROJECT_TOKENS.projectMembers)) return undefined;

        const User = systemModel('UserAP');
        if (!User) return res.json({ data: [] });
        const query = str(req.query?.q).trim();
        // No e-mail invitations: a person is added only if they already have a panel account, and
        // an empty result says so instead of offering to create one.
        const where = query
          ? {
              [Op.or]: [
                { login: { [Op.like]: `%${query}%` } },
                { fullName: { [Op.like]: `%${query}%` } },
                { email: { [Op.like]: `%${query}%` } },
              ],
            }
          : {};
        const users = await User.findAll({ where: where as any, order: [['login', 'ASC']], limit: 20 });
        return res.json({ data: users.map((user) => publicUser(plain(user))) });
      }

      if (!requirePanelUser(req, res)) return undefined;
      return req.Inertia.render({
        component: 'module',
        props: { moduleComponent: '/dashboard/modules/AgentizMembers.js' },
      });
    },
  },
  {
    route: ROUTE,
    method: 'post',
    handler: async (req, res) => {
      try {
        const method = str(req.body?._method);
        const actorId = Number(panelActor(req) && (panelActor(req) as any).id);

        if (method === 'addMember') {
          const projectId = str(req.body?.projectId);
          if (!await guardProject(req, res, projectId, PROJECT_TOKENS.projectMembers)) return undefined;

          const userId = Number(req.body?.userId);
          const groupId = Number(req.body?.groupId);
          if (!Number.isFinite(userId) || !Number.isFinite(groupId)) {
            return res.status(400).json({ message: 'userId и groupId обязательны' });
          }
          const existing = await AgentProjectMember.findOne({ where: { projectId, userId, groupId } });
          if (existing) return res.status(409).json({ message: 'У этого человека уже есть такая роль в проекте' });

          const member = await AgentProjectMember.create({
            projectId,
            userId,
            groupId,
            grantedByUserId: Number.isFinite(actorId) ? actorId : null,
          });
          return res.json({ data: { id: member.id } });
        }

        if (method === 'setRole' || method === 'removeMember') {
          const member = await AgentProjectMember.findByPk(str(req.body?.memberId));
          // 404 before the right is checked would leak nothing, but checking the right first keeps
          // the answer for a foreign project's row identical to the answer for a missing one.
          if (!member) return res.status(404).json({ message: 'Участник не найден' });
          if (!await guardProject(req, res, member.projectId, PROJECT_TOKENS.projectMembers)) return undefined;

          if (method === 'removeMember') {
            const project = await AgentProject.findByPk(member.projectId, { attributes: ['id', 'ownerId'] });
            if (project?.ownerId !== null && Number(project?.ownerId) === Number(member.userId)) {
              return res.status(409).json({
                message: 'Владельца проекта нельзя убрать: без строки членства проект перестанет быть виден ему самому',
              });
            }
            await member.destroy();
            return res.json({ data: { ok: true } });
          }

          const groupId = Number(req.body?.groupId);
          if (!Number.isFinite(groupId)) return res.status(400).json({ message: 'groupId обязателен' });
          const duplicate = await AgentProjectMember.findOne({
            where: { projectId: member.projectId, userId: member.userId, groupId },
          });
          if (duplicate && duplicate.id !== member.id) {
            return res.status(409).json({ message: 'У этого человека уже есть такая роль в проекте' });
          }
          await member.update({ groupId, grantedByUserId: Number.isFinite(actorId) ? actorId : member.grantedByUserId });
          return res.json({ data: { id: member.id } });
        }

        return res.status(400).json({ message: `Unknown _method: ${method || '(none)'}` });
      } catch (error: any) {
        return res.status(400).json({ message: error?.message ?? String(error) });
      }
    },
  },
];
