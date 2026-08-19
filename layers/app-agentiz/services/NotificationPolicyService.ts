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

  /** Drops the in-memory value of the removed document, which app-manager leaves in place on destroy. */
  private static clearSlotValue(): void {
    const slot = holder()[MANAGER_KEY]?.settingStorage?.getSettingSlot(NOTIFY_POLICY_KEY);
    if (slot) delete slot.value;
  }
}
