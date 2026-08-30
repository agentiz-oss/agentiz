import { Op } from 'sequelize';
import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { PipelineSpec } from '../../app-agentiz/models/PipelineSpec';
import { NotificationPolicyService } from '../../app-agentiz/services/NotificationPolicyService';
import { activityTypes, builtinActivityDefaults } from '../../app-agentiz/lib/notifications/activityTypes';
import { storedNotifyPolicy, type ActivityPolicyScope, type NotifyPolicyDocument } from '../../app-agentiz/lib/notifications/policySettings';
import { MobileAuthError } from './MobileAuthService';
import { canInProject, visibleProjectIds } from '../lib/mobileScope';
import { PROJECT_TOKENS } from '../../app-agentiz/lib/access/tokens';

/**
 * The notification policy as one phone owner sees it.
 *
 * The stored document is installation-wide (one settings slot), but a mobile caller must neither
 * see nor overwrite other people's project entries. GET filters the document down to the projects
 * the caller takes part in and their pipelines; PUT merges: for each map the caller **sends** it
 * replaces their own entries and carries foreign ones through untouched, a map they omit is left as
 * stored, and an id they have no part in is refused.
 * Last-write-wins between two simultaneous editors — accepted for v1.
 *
 * Scope is membership, not ownership — the same rule as everywhere else in this layer — and the
 * gate is `agentiz-project-configure`: deciding what a project's runs wake people up about is a
 * project setting, not something every reader may change. That matters beyond this screen, because
 * the inbox's per-row "не присылать такое" gesture writes through here; a member who could not
 * reach it would see the gesture fail with no explanation.
 *
 * **Known hole, left as it was on purpose.** The `defaults` scope is the tail of every resolution
 * in the whole installation, and any authenticated phone can still overwrite it — the panel now
 * asks for `agentiz-notifications-manage` there, this endpoint asks for nothing. It is not closed
 * here because the app's own settings screen posts the whole document back including `defaults`
 * (NotificationsScreen.kt), so refusing it would break that screen for everybody, and a mobile
 * caller is never an administrator — only a user id reaches this layer. Closing it needs the client
 * to stop sending `defaults` (or to send it only when it changed) and ships together with that.
 */
export class MobileNotificationPolicyService {
  /** Projects whose notification rules this caller may see. */
  private static async visibleProjects(userId: number | string): Promise<string[]> {
    return visibleProjectIds(userId);
  }

  /** …and the narrower set they may change. */
  private static async configurableProjects(userId: number | string): Promise<string[]> {
    const visible = await this.visibleProjects(userId);
    const decisions = await Promise.all(
      visible.map((projectId) => canInProject(projectId, userId, PROJECT_TOKENS.projectConfigure)),
    );
    return visible.filter((_id, index) => decisions[index]);
  }

  private static async ownedPipelineIds(projectIds: string[]): Promise<string[]> {
    if (projectIds.length === 0) return [];
    const specs = await PipelineSpec.findAll({ where: { projectId: { [Op.in]: projectIds } }, attributes: ['id'] });
    return specs.map((spec) => spec.id);
  }

  static async describe(ownerId: number | string) {
    const summary = NotificationPolicyService.describe();
    const projectIds = await this.visibleProjects(ownerId);
    const pipelineIds = new Set(await this.ownedPipelineIds(projectIds));
    const owned = new Set(projectIds);
    return {
      defaults: summary.document.defaults ?? {},
      projects: Object.fromEntries(Object.entries(summary.document.projects ?? {}).filter(([id]) => owned.has(id))),
      pipelines: Object.fromEntries(Object.entries(summary.document.pipelines ?? {}).filter(([id]) => pipelineIds.has(id))),
      source: summary.source,
      shadowedByEnvironment: summary.shadowedByEnvironment,
      builtinDefaults: builtinActivityDefaults(),
      types: activityTypes().map((def) => ({ type: def.type, kind: def.kind, label: def.label })),
    };
  }

  static async update(
    ownerId: number | string,
    input: { defaults?: ActivityPolicyScope; projects?: Record<string, ActivityPolicyScope>; pipelines?: Record<string, ActivityPolicyScope> },
  ) {
    const projectIds = await this.configurableProjects(ownerId);
    const owned = new Set(projectIds);
    const ownedPipelines = new Set(await this.ownedPipelineIds(projectIds));

    for (const id of Object.keys(input.projects ?? {})) {
      if (!owned.has(id)) throw new MobileAuthError(403, `Project ${id} is not yours to configure`);
    }
    for (const id of Object.keys(input.pipelines ?? {})) {
      if (!ownedPipelines.has(id)) throw new MobileAuthError(403, `Pipeline ${id} is not yours to configure`);
    }

    // Merge over the *stored* document, not the effective one: writes land in the store, and with
    // the env shadowing everything, merging the env copy back in would freeze it there forever.
    const base: NotifyPolicyDocument = storedNotifyPolicy() ?? {};

    const keepForeign = (entries: Record<string, ActivityPolicyScope> | undefined, ownedIds: Set<string>) =>
      Object.fromEntries(Object.entries(entries ?? {}).filter(([id]) => !ownedIds.has(id)));

    /**
     * A map the caller did not send is left alone; a map they did send replaces **their own**
     * entries in it wholesale (that is how a rule is removed — by sending the map without it).
     *
     * The distinction matters now that two screens write this document: the inbox edits one
     * project or one pipeline entry and sends only that map, and an omitted `pipelines` used to be
     * read as "no pipeline rules", quietly deleting every pipeline rule the owner had.
     */
    const mergeScopes = (
      stored: Record<string, ActivityPolicyScope> | undefined,
      incoming: Record<string, ActivityPolicyScope> | undefined,
      ownedIds: Set<string>,
    ) => (incoming === undefined ? { ...(stored ?? {}) } : { ...keepForeign(stored, ownedIds), ...incoming });

    const merged: NotifyPolicyDocument = {
      ...(input.defaults !== undefined ? { defaults: input.defaults } : base.defaults ? { defaults: base.defaults } : {}),
      projects: mergeScopes(base.projects, input.projects, owned),
      pipelines: mergeScopes(base.pipelines, input.pipelines, ownedPipelines),
    };

    const result = await this.rethrowingValidation(() => NotificationPolicyService.set(merged));
    return { ...(await this.describe(ownerId)), warnings: result.warnings, pruned: result.pruned };
  }

  /** Ajv rejections are client errors here, not server ones. */
  private static async rethrowingValidation<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof Error && error.message.includes('does not match the schema')) {
        throw new MobileAuthError(400, error.message);
      }
      throw error;
    }
  }
}
