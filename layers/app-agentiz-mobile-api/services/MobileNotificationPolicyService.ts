import { Op } from 'sequelize';
import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { PipelineSpec } from '../../app-agentiz/models/PipelineSpec';
import { NotificationPolicyService } from '../../app-agentiz/services/NotificationPolicyService';
import { activityTypes, builtinActivityDefaults } from '../../app-agentiz/lib/notifications/activityTypes';
import { storedNotifyPolicy, type ActivityPolicyScope, type NotifyPolicyDocument } from '../../app-agentiz/lib/notifications/policySettings';
import { MobileAuthError } from './MobileAuthService';

/**
 * The notification policy as one phone owner sees it.
 *
 * The stored document is installation-wide (one settings slot), but a mobile caller must neither
 * see nor overwrite other owners' project entries. GET filters the document down to the caller's
 * projects and their pipelines; PUT merges: it replaces `defaults` and the caller's own entries,
 * carries every foreign entry through untouched, and refuses ids the caller does not own.
 * Last-write-wins between two simultaneous editors — accepted for v1.
 */
export class MobileNotificationPolicyService {
  private static async ownedProjectIds(ownerId: number | string): Promise<string[]> {
    const projects = await AgentProject.findAll({ where: { ownerId: ownerId as any }, attributes: ['id'] });
    return projects.map((project) => project.id);
  }

  private static async ownedPipelineIds(projectIds: string[]): Promise<string[]> {
    if (projectIds.length === 0) return [];
    const specs = await PipelineSpec.findAll({ where: { projectId: { [Op.in]: projectIds } }, attributes: ['id'] });
    return specs.map((spec) => spec.id);
  }

  static async describe(ownerId: number | string) {
    const summary = NotificationPolicyService.describe();
    const projectIds = await this.ownedProjectIds(ownerId);
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
    const projectIds = await this.ownedProjectIds(ownerId);
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

    const merged: NotifyPolicyDocument = {
      ...(input.defaults !== undefined ? { defaults: input.defaults } : base.defaults ? { defaults: base.defaults } : {}),
      projects: { ...keepForeign(base.projects, owned), ...(input.projects ?? {}) },
      pipelines: { ...keepForeign(base.pipelines, ownedPipelines), ...(input.pipelines ?? {}) },
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
