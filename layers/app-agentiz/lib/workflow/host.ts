import { AppManager } from '@nodeknit/app-manager';
import { AgentProject } from '../../models/AgentProject';
import type { WorkflowHost } from '@nodeknit/app-workflow';

/**
 * The host seam: everything of Agentiz's own that the engine is allowed to reach.
 *
 * Minimal on purpose, and each answer is a decision rather than a placeholder:
 *
 * - `checkPermission` — the person's **global** groups, plus the administrator flag. The engine's
 *   signature is `(userId, token)` and carries no project, so a project-scoped answer is not
 *   expressible here; a graph belongs to a project (`AgentWorkflowSpec.projectId`) but the engine
 *   never says which one. Scoping a flow therefore stays with the canvas routes and the MCP tools,
 *   which do know the project and ask `projectAccess.can()`. What this method can honestly answer
 *   is the global half, and it does — the previous unconditional `true` would have handed the
 *   whole engine to anybody the moment enforcement landed.
 * - `resolveSecret` — `process.env`, the same source every other credential in this layer reads.
 * - `notify` — the run log. It deliberately does **not** call `ActivityService.record()` yet: that
 *   dispatcher's event types are a closed catalogue (`lib/notifications/activityTypes.ts`) which
 *   the policy schema and the UI hints are generated from, so `workflow.*` events are a change to
 *   make there, once, rather than a string smuggled in from here.
 */
export class AgentizWorkflowHost implements WorkflowHost {
  async checkPermission(userId: string | number | null, token: string): Promise<boolean> {
    if (userId === null || userId === undefined) return false;
    // Reached through a registered model rather than an AppManager singleton: the engine may call
    // this from a resumed run, outside any request, and the ORM registry is the one thing always
    // there once the layer has mounted.
    const sequelize = AgentProject.sequelize;
    if (!sequelize || !sequelize.isDefined('UserAP')) return false;
    const UserAP = sequelize.model('UserAP');
    const hasGroups = Boolean((UserAP.associations as Record<string, unknown> | undefined)?.groups);
    // Without the groups the token check below is silently false for everybody — the same trap the
    // mobile authentication used to sit in.
    const user = await UserAP.findByPk(userId as any, hasGroups ? { include: [{ association: 'groups' }] } : undefined);
    if (!user) return false;
    const plain = user.get({ plain: true }) as any;
    if (plain.isAdministrator) return true;
    const wanted = token.toLowerCase();
    return (plain.groups ?? []).some((group: any) =>
      (group?.tokens ?? []).some((grant: unknown) =>
        (typeof grant === 'string' && grant.toLowerCase() === wanted)
        || (grant as any)?.tokenId?.toLowerCase?.() === wanted));
  }

  async resolveSecret(key: string): Promise<string | undefined> {
    return process.env[key];
  }

  async notify(event: { type: string; message: string; meta?: Record<string, unknown> }): Promise<void> {
    AppManager.log.warn(`[AppAgentiz] workflow ${event.type}: ${event.message}`, event.meta ?? '');
  }

  now(): Date {
    return new Date();
  }
}
