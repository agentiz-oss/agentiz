import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { maskProjectForUI } from '../../app-agentiz/lib/secrets';

/**
 * Read access to Agentiz projects for the mobile client, scoped to the caller.
 *
 * Scope mirrors the admin panel's `userAccessRelation: 'owner'` on AgentProject: a mobile user sees
 * exactly the projects they own. Secrets are stripped through the same `maskProjectForUI` the admin
 * API uses, so a project token never leaves the server in clear text.
 */
export class MobileProjectService {
  static async listForOwner(ownerId: number | string): Promise<unknown[]> {
    const projects = await AgentProject.findAll({
      where: { ownerId: ownerId as any },
      order: [['createdAt', 'DESC']],
    });
    return projects.map(maskProjectForUI);
  }

  static async getForOwner(projectId: string, ownerId: number | string): Promise<unknown | null> {
    const project = await AgentProject.findByPk(projectId);
    // findByPk then an explicit owner check (rather than a compound where) so an existing project
    // owned by someone else is a 404, indistinguishable from one that does not exist.
    if (!project || String(project.ownerId ?? '') !== String(ownerId)) return null;
    return maskProjectForUI(project);
  }
}
