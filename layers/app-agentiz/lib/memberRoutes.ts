import type { AdminizerRouteMiddleware } from '@nodeknit/app-adminizer';
import { AgentProject } from '../models/AgentProject';
import { AgentProjectMember } from '../models/AgentProjectMember';
import { guardProject, panelActor, requestAccessCache, requirePanelUser } from './access/panelGuard';
import { PROJECT_TOKENS } from './access/tokens';
import { legacyRedirect } from './panel/legacyRedirect';
import { memberCandidates, projectMembersView } from './panel/settingsPanel';

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

export const memberRoutes: AdminizerRouteMiddleware[] = [
  {
    route: ROUTE,
    method: 'get',
    handler: async (req, res) => {
      const method = str(req.query?._method);

      if (method === 'list') {
        const projectId = str(req.query?.projectId);
        if (!await guardProject(req, res, projectId, PROJECT_TOKENS.read)) return undefined;

        // Built by `lib/panel/settingsPanel.ts`, which is also what paints the first frame of the
        // «Участники» section — so the rows a person sees after pressing a button are the rows
        // the page was rendered with.
        const view = await projectMembersView(projectId, panelActor(req), requestAccessCache(req));
        if (!view) return res.status(404).json({ message: 'Проект не найден' });
        return res.json({ data: view.items, meta: view.meta });
      }

      if (method === 'candidates') {
        const projectId = str(req.query?.projectId);
        if (!await guardProject(req, res, projectId, PROJECT_TOKENS.projectMembers)) return undefined;
        return res.json({ data: await memberCandidates(str(req.query?.q).trim()) });
      }

      if (!requirePanelUser(req, res)) return undefined;
      // Membership is a section of a project's settings now, so without `?projectId=` there is
      // nothing to open but the project list.
      return legacyRedirect(req, res, 'projects');
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
