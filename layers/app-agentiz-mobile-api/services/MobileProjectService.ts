import { Op } from 'sequelize';
import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { maskProjectForUI } from '../../app-agentiz/lib/secrets';
import { canInProject, visibleProjectIds } from '../lib/mobileScope';

/**
 * Read access to Agentiz projects for the mobile client, scoped to the caller.
 *
 * Scope is membership, not ownership: a person sees the projects they own **and** the projects
 * they hold a membership row in (`app-agentiz/lib/access/projectAccess.ts`), which is the same
 * rule the panel's access graph applies to the same person. Secrets are stripped through the same
 * `maskProjectForUI` the admin API uses, so a project token never leaves the server in clear text.
 */
export class MobileProjectService {
  static async listForOwner(ownerId: number | string): Promise<unknown[]> {
    const projectIds = await visibleProjectIds(ownerId);
    if (projectIds.length === 0) return [];
    const projects = await AgentProject.findAll({
      where: { id: { [Op.in]: projectIds } },
      order: [['createdAt', 'DESC']],
    });
    return projects.map(maskProjectForUI);
  }

  static async getForOwner(projectId: string, ownerId: number | string): Promise<unknown | null> {
    // findByPk then an explicit access check (rather than a compound where) so an existing project
    // the caller has no part in is a 404, indistinguishable from one that does not exist.
    const project = await AgentProject.findByPk(projectId);
    if (!project || !(await canInProject(project.id, ownerId))) return null;
    return maskProjectForUI(project);
  }
}
