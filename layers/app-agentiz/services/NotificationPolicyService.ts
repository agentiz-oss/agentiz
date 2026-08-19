import Ajv from 'ajv';
import { Op } from 'sequelize';
import { AgentProject } from '../models/AgentProject';
import { PipelineSpec } from '../models/PipelineSpec';
import {
  NOTIFY_POLICY_KEY,
  isNotifyPolicyShadowedByEnvironment,
  notifyPolicy,
  notifyPolicyJsonSchema,
  notifyPolicySource,
  resolveActivityPolicy,
  storedNotifyPolicy,
  type ActivityPolicyEntry,
  type ActivityPolicyScope,
  type NotifyPolicyDocument,
  type NotifyPolicySource,
} from '../lib/notifications/policySettings';
import { activityTypes, builtinActivityDefaults, type ActivityChannelPolicy } from '../lib/notifications/activityTypes';

/**
 * Reading and writing the AGENTIZ_NOTIFY_POLICY document (pattern: PushSettingsService).
 *
 * The value is one JSON document, not per-key settings, so `set` replaces it wholesale — merge
 * semantics for partial editors (the mobile API) live with those editors, not here. Not a secret,
 * so no log redaction and `describe()` returns the document in full.
 *
 * Environment shadowing is all-or-nothing: `AGENTIZ_NOTIFY_POLICY` in `.env` hides the entire
 * stored document, which is why a shadowed write comes back with a warning instead of silently
 * doing nothing visible. (For json+env slots `SettingStorage.get` also recompiles the Ajv schema
 * on every read — prefer storing in the database.)
 */

export interface NotifyPolicySummary {
  document: NotifyPolicyDocument;
  source: NotifyPolicySource;
  shadowedByEnvironment: boolean;
  /** The tail of every resolution — what applies where nothing is configured. */
  builtinDefaults: Record<string, ActivityChannelPolicy>;
  /** The catalogue, for UIs building the type × channel matrix. */
  types: Array<{ type: string; kind: string; label: string }>;
  warnings: string[];
}

/** Which of the document's three scopes an editor is pointed at. */
export type PolicyScopeRef =
  | { scope: 'defaults'; id?: undefined }
  | { scope: 'project'; id: string }
  | { scope: 'pipeline'; id: string };

/** One type's row in a scope editor: what this scope says, what applies, what would apply without it. */
export interface PolicyScopeTypeView {
  type: string;
  kind: string;
  label: string;
  /** Only what *this* scope stores — the editor's own state, empty when it says nothing. */
  own: ActivityPolicyEntry;
  /** What is delivered today, this scope included. */
  effective: ActivityChannelPolicy;
  /** What would be delivered if this scope's entry were removed — the "наследуется" hint. */
  inherited: ActivityChannelPolicy;
}

/** One scope that stores something, with the name of the thing it is attached to. */
export interface PolicyOverrideView {
  scope: PolicyScopeRef['scope'];
  id?: string;
  name: string;
  /** For a pipeline — the project it inherits from, so a list can group by it and link into it. */
  projectId?: string;
  projectName?: string;
  mute: boolean;
  types: string[];
}

export interface PolicyScopeView {
  scope: PolicyScopeRef['scope'];
  id?: string;
  mute: boolean;
  types: PolicyScopeTypeView[];
  source: NotifyPolicySource;
  shadowedByEnvironment: boolean;
  warnings: string[];
}

interface SettingRow {
  key: string;
  value: unknown;
  update(values: Record<string, unknown>): Promise<unknown>;
  destroy(): Promise<unknown>;
}

interface SettingModel {
  findOne(options: { where: { key: string } }): Promise<SettingRow | null>;
  create(values: { key: string; value: unknown }): Promise<SettingRow>;
}

interface AppManagerLike {
  sequelize?: { models?: Record<string, unknown> };
  settingStorage?: { getSettingSlot(key: string): { value?: unknown } | undefined };
}

// Set at mount, read when something is written. Symbol.for for the usual tsx double-graph reason.
const MANAGER_KEY = Symbol.for('agentiz.notifyPolicy.writer');

function holder(): Record<symbol, AppManagerLike | null> {
  return globalThis as unknown as Record<symbol, AppManagerLike | null>;
}

const ajv = new Ajv({ allErrors: true });

export class NotificationPolicyService {
  /** Called by the layer at mount, with the same AppManager the settings collection was processed by. */
  static use(appManager: AppManagerLike): void {
    holder()[MANAGER_KEY] = appManager;
  }

  static forget(): void {
    holder()[MANAGER_KEY] = null;
  }

  private static model(): SettingModel {
    const model = holder()[MANAGER_KEY]?.sequelize?.models?.Setting as SettingModel | undefined;
    if (!model) throw new Error('settings storage is unavailable: app-agentiz is not mounted');
    return model;
  }

  static describe(): NotifyPolicySummary {
    const warnings: string[] = [];
    if (isNotifyPolicyShadowedByEnvironment()) {
      warnings.push(`${NOTIFY_POLICY_KEY} is stored here but the environment variable overrides the entire document; remove it from .env for stored values to take effect`);
    }
    return {
      document: notifyPolicy(),
      source: notifyPolicySource(),
      shadowedByEnvironment: isNotifyPolicyShadowedByEnvironment(),
      builtinDefaults: builtinActivityDefaults(),
      types: activityTypes().map((def) => ({ type: def.type, kind: def.kind, label: def.label })),
      warnings,
    };
  }

  /**
   * Validates, prunes and stores the whole document. Pruning drops `projects`/`pipelines` entries
   * whose id no longer exists — stale ids would otherwise accumulate forever, since nothing else
   * ever walks the document. `null` removes the stored document entirely (back to built-ins, or to
   * the environment if it sets the key).
   */
  static async set(document: NotifyPolicyDocument | null): Promise<NotifyPolicySummary & { pruned: string[] }> {
    const model = this.model();
    const pruned: string[] = [];

    if (document === null) {
      const existing = await model.findOne({ where: { key: NOTIFY_POLICY_KEY } });
      if (existing) await existing.destroy();
      this.clearSlotValue();
      return { ...this.describe(), pruned };
    }

    const validate = ajv.compile(notifyPolicyJsonSchema());
    if (!validate(document)) {
      const detail = ajv.errorsText(validate.errors, { separator: '; ' });
      throw new Error(`${NOTIFY_POLICY_KEY} does not match the schema: ${detail}. Known types: ${activityTypes().map((def) => def.type).join(', ')}`);
    }

    const cleaned: NotifyPolicyDocument = { ...document };
    if (cleaned.projects && Object.keys(cleaned.projects).length > 0) {
      const ids = Object.keys(cleaned.projects);
      const existing = new Set((await AgentProject.findAll({ where: { id: { [Op.in]: ids } }, attributes: ['id'] })).map((row) => row.id));
      cleaned.projects = Object.fromEntries(Object.entries(cleaned.projects).filter(([id]) => {
        if (existing.has(id)) return true;
        pruned.push(`projects.${id}`);
        return false;
      }));
    }
    if (cleaned.pipelines && Object.keys(cleaned.pipelines).length > 0) {
      const ids = Object.keys(cleaned.pipelines);
      const existing = new Set((await PipelineSpec.findAll({ where: { id: { [Op.in]: ids } }, attributes: ['id'] })).map((row) => row.id));
      cleaned.pipelines = Object.fromEntries(Object.entries(cleaned.pipelines).filter(([id]) => {
        if (existing.has(id)) return true;
        pruned.push(`pipelines.${id}`);
        return false;
      }));
    }

    const existing = await model.findOne({ where: { key: NOTIFY_POLICY_KEY } });
    if (existing) {
      // Through the instance, not the model: app-manager's hooks write the value back into
      // settingStorage, and a bulk update would skip them.
      await existing.update({ value: cleaned });
    } else {
      await model.create({ key: NOTIFY_POLICY_KEY, value: cleaned });
    }

    return { ...this.describe(), pruned };
  }

  /**
   * One scope as an editor sees it: its own entries, what they resolve to, and what would apply
   * without them. The three scope editors in the panel are the same component pointed at different
   * refs, so the shape must not depend on which scope it is.
   */
  static async describeScope(target: PolicyScopeRef): Promise<PolicyScopeView> {
    const document = notifyPolicy();
    const { projectId, pipelineSpecId } = await this.resolveIds(target);
    const scope = this.scopeOf(document, target) ?? {};
    // Inheritance is defined as "this scope's entry is gone", so resolve against a copy without it.
    const without = this.withoutScope(document, target);

    return {
      scope: target.scope,
      id: target.id,
      mute: scope.mute === true,
      types: activityTypes().map((def) => ({
        type: def.type,
        kind: def.kind,
        label: def.label,
        own: (typeof scope[def.type] === 'object' ? scope[def.type] as ActivityPolicyEntry : {}),
        effective: resolveActivityPolicy(document, def.type, projectId, pipelineSpecId),
        inherited: resolveActivityPolicy(without, def.type, projectId, pipelineSpecId),
      })),
      source: notifyPolicySource(),
      shadowedByEnvironment: isNotifyPolicyShadowedByEnvironment(),
      warnings: this.describe().warnings,
    };
  }

  /**
   * Every scope the document actually says something about, named.
   *
   * Without this the document becomes a place where an override made months ago in a project card
   * cannot be found again: nothing else ever lists them, and silence has no visible cause.
   */
  static async listOverrides(): Promise<PolicyOverrideView[]> {
    const document = notifyPolicy();
    const projectIds = Object.keys(document.projects ?? {});
    const pipelineIds = Object.keys(document.pipelines ?? {});

    const specs = pipelineIds.length > 0
      ? await PipelineSpec.findAll({ where: { id: { [Op.in]: pipelineIds } }, attributes: ['id', 'name', 'projectId'] })
      : [];
    // The projects to name are those with an entry of their own *plus* the owners of every listed
    // pipeline — a pipeline is shown under its project even when the project says nothing.
    const namedProjectIds = [...new Set([...projectIds, ...specs.map((spec) => spec.projectId)])];
    const projects = namedProjectIds.length > 0
      ? await AgentProject.findAll({ where: { id: { [Op.in]: namedProjectIds } }, attributes: ['id', 'name'] })
      : [];
    const projectNames = new Map(projects.map((project) => [project.id, project.name]));

    const typesOf = (scope: ActivityPolicyScope) => Object.keys(scope).filter((key) => key !== 'mute');
    const views: PolicyOverrideView[] = [];

    if (document.defaults && Object.keys(document.defaults).length > 0) {
      views.push({ scope: 'defaults', name: 'Общие настройки', mute: document.defaults.mute === true, types: typesOf(document.defaults) });
    }
    for (const [id, scope] of Object.entries(document.projects ?? {})) {
      views.push({
        scope: 'project',
        id,
        // A stale id survives here until the next write prunes it, so say so rather than show blank.
        name: projectNames.get(id) ?? `Проект ${id} (удалён)`,
        mute: scope.mute === true,
        types: typesOf(scope),
      });
    }
    for (const [id, scope] of Object.entries(document.pipelines ?? {})) {
      const spec = specs.find((item) => item.id === id);
      views.push({
        scope: 'pipeline',
        id,
        name: spec?.name ?? `Пайплайн ${id} (удалён)`,
        projectId: spec?.projectId,
        projectName: spec ? projectNames.get(spec.projectId) ?? undefined : undefined,
        mute: scope.mute === true,
        types: typesOf(scope),
      });
    }
    return views;
  }

  /**
   * Replaces one scope's entry, carrying every other scope through untouched — `set()` replaces
   * the whole document, and three editors (project card, pipeline editor, defaults page) writing
   * through it would overwrite each other. `null` removes the entry entirely.
   *
   * Merged over the **stored** document, never the effective one: writes land in the store, and
   * with the environment shadowing everything, merging its copy back in would freeze it there.
   */
  static async patchScope(target: PolicyScopeRef, entry: ActivityPolicyScope | null): Promise<PolicyScopeView & { pruned: string[] }> {
    const base: NotifyPolicyDocument = storedNotifyPolicy() ?? {};
    const merged: NotifyPolicyDocument = { ...base };

    if (target.scope === 'defaults') {
      if (entry === null) delete merged.defaults;
      else merged.defaults = entry;
    } else {
      const key = target.scope === 'project' ? 'projects' : 'pipelines';
      const bucket = { ...(base[key] ?? {}) };
      if (entry === null) delete bucket[target.id];
      else bucket[target.id] = entry;
      if (Object.keys(bucket).length > 0) merged[key] = bucket;
      else delete merged[key];
    }

    const result = await this.set(merged);
    return { ...(await this.describeScope(target)), pruned: result.pruned };
  }

  /** The project/pipeline pair a scope resolves against — a pipeline inherits through its project. */
  private static async resolveIds(target: PolicyScopeRef): Promise<{ projectId?: string; pipelineSpecId?: string }> {
    if (target.scope === 'project') return { projectId: target.id };
    if (target.scope === 'pipeline') {
      const spec = await PipelineSpec.findByPk(target.id, { attributes: ['id', 'projectId'] });
      if (!spec) throw new Error(`Pipeline spec ${target.id} not found`);
      return { projectId: spec.projectId, pipelineSpecId: spec.id };
    }
    return {};
  }

  private static scopeOf(document: NotifyPolicyDocument, target: PolicyScopeRef): ActivityPolicyScope | undefined {
    if (target.scope === 'defaults') return document.defaults;
    if (target.scope === 'project') return document.projects?.[target.id];
    return document.pipelines?.[target.id];
  }

  private static withoutScope(document: NotifyPolicyDocument, target: PolicyScopeRef): NotifyPolicyDocument {
    const copy: NotifyPolicyDocument = { ...document };
    if (target.scope === 'defaults') {
      delete copy.defaults;
      return copy;
    }
    const key = target.scope === 'project' ? 'projects' : 'pipelines';
    const bucket = { ...(document[key] ?? {}) };
    delete bucket[target.id];
    copy[key] = bucket;
    return copy;
  }

  /** Drops the in-memory value of the removed document, which app-manager leaves in place on destroy. */
  private static clearSlotValue(): void {
    const slot = holder()[MANAGER_KEY]?.settingStorage?.getSettingSlot(NOTIFY_POLICY_KEY);
    if (slot) delete slot.value;
  }
}
