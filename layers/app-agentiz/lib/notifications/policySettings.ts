/**
 * The notification policy — one JSON document in an app-manager Settings slot.
 *
 * Same mechanism as the mobile layer's push credentials (`lib/push/settings.ts`), and for the same
 * reason: "what wakes a person up" is a preference an administrator changes without a deploy, so it
 * lives in the platform's `settings` table, not in a table of this layer's own and **not** in
 * `PipelineSpec.spec` — a spec is snapshotted into every run and shipped to the worker, and a
 * preference must not freeze at queue time.
 *
 * The document has three scopes, resolved from specific to general per **channel**:
 * `pipelines[specId]` → `projects[projectId]` → `defaults` → the built-in default from the type
 * catalogue. Inside a scope an explicit type entry wins, then the scope's `mute: true` shortcut,
 * then resolution falls through to the next scope. Consequence, deliberately: "the project is
 * muted, except the release pipeline which is explicitly on" needs no special casing.
 *
 * app-manager's rule applies unchanged: `process.env.AGENTIZ_NOTIFY_POLICY` shadows the stored
 * document *entirely*, which is why every reader here also reports the source.
 *
 * Reads are synchronous and in-memory: settingStorage holds the slot's value, and
 * `Setting.afterSaveHook` refreshes it on every write — a change takes effect without a restart
 * and without any cache of ours to invalidate.
 */

import {
  activityTypes,
  builtinActivityDefaults,
  type ActivityChannelPolicy,
  type ActivityDashboardMode,
  type ActivityPushMode,
} from './activityTypes';

export const NOTIFY_POLICY_KEY = 'AGENTIZ_NOTIFY_POLICY';

/** Partial per-type override: either channel may be set alone. */
export interface ActivityPolicyEntry {
  push?: ActivityPushMode;
  dashboard?: ActivityDashboardMode;
}

/** One scope: per-type overrides plus the `mute` shortcut ("everything off, without listing types"). */
export type ActivityPolicyScope = { mute?: boolean } & Record<string, ActivityPolicyEntry | boolean | undefined>;

export interface NotifyPolicyDocument {
  defaults?: ActivityPolicyScope;
  projects?: Record<string, ActivityPolicyScope>;
  pipelines?: Record<string, ActivityPolicyScope>;
}

/** JSON schema of the document, generated from the type catalogue — required for a json slot. */
export function notifyPolicyJsonSchema(): Record<string, unknown> {
  const typeProperties = Object.fromEntries(activityTypes().map((def) => [def.type, {
    type: 'object',
    additionalProperties: false,
    properties: {
      push: { enum: ['on', 'silent', 'off'] },
      dashboard: { enum: ['on', 'off'] },
    },
  }]));
  const scope = {
    type: 'object',
    additionalProperties: false,
    properties: { mute: { type: 'boolean' }, ...typeProperties },
  };
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      defaults: scope,
      projects: { type: 'object', additionalProperties: scope },
      pipelines: { type: 'object', additionalProperties: scope },
    },
  };
}

/** The shape app-manager's SettingHandler instantiates (see lib/push/settings.ts for the pattern). */
export interface NotifySettingSlot {
  key: string;
  type: 'string' | 'boolean' | 'json' | 'number';
  name?: string;
  description?: string;
  jsonSchema?: unknown;
  value?: unknown;
}

/** The slot class — app-manager does `new item()` on every settings-collection entry. */
export class NotifyPolicySlot implements NotifySettingSlot {
  key = NOTIFY_POLICY_KEY;
  type = 'json' as const;
  name = 'Notification policy';
  description = 'What Agentiz notifies about, per event type, project and pipeline. The activity feed is always written; this document only filters push and dashboard delivery.';
  jsonSchema = notifyPolicyJsonSchema();
}

export const notifyPolicySettingSlots: (new () => NotifySettingSlot)[] = [NotifyPolicySlot];

interface SettingStorageLike {
  get(settingClass: new () => NotifySettingSlot): unknown;
  getSettingSlot(key: string): NotifySettingSlot | undefined;
}

interface AppManagerLike {
  settingStorage?: SettingStorageLike;
}

// Same tsx double-instantiation hazard as every other registry here — hence the global symbol.
const MANAGER_KEY = Symbol.for('agentiz.notifyPolicy.settingsManager');

function holder(): Record<symbol, AppManagerLike | null> {
  return globalThis as unknown as Record<symbol, AppManagerLike | null>;
}

/** Called by the layer at mount. Until then, and in unit tests, the environment is the only source. */
export function useNotifySettingStorage(appManager: AppManagerLike): void {
  holder()[MANAGER_KEY] = appManager;
}

export function forgetNotifySettingStorage(): void {
  holder()[MANAGER_KEY] = null;
}

function storage(): SettingStorageLike | null {
  return holder()[MANAGER_KEY]?.settingStorage ?? null;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fromEnv(): NotifyPolicyDocument | undefined {
  const raw = process.env[NOTIFY_POLICY_KEY];
  if (raw === undefined || raw === '') return undefined;
  try {
    const parsed = JSON.parse(raw);
    return plainObject(parsed) ? parsed as NotifyPolicyDocument : undefined;
  } catch {
    console.warn(`[app-agentiz] ${NOTIFY_POLICY_KEY} in the environment is not valid JSON and is ignored`);
    return undefined;
  }
}

/** The document stored in the settings table, ignoring the environment. */
export function storedNotifyPolicy(): NotifyPolicyDocument | undefined {
  const value = storage()?.getSettingSlot(NOTIFY_POLICY_KEY)?.value;
  return plainObject(value) ? value as NotifyPolicyDocument : undefined;
}

/** The document in force: the environment if it sets the key, else what an administrator stored. */
export function notifyPolicy(): NotifyPolicyDocument {
  return fromEnv() ?? storedNotifyPolicy() ?? {};
}

export type NotifyPolicySource = 'environment' | 'settings' | 'unset';

/** Which source answered — the first thing to check when a policy change "did not apply". */
export function notifyPolicySource(): NotifyPolicySource {
  if (fromEnv() !== undefined) return 'environment';
  return storedNotifyPolicy() === undefined ? 'unset' : 'settings';
}

/** True when a stored document exists but the environment is what is actually read. */
export function isNotifyPolicyShadowedByEnvironment(): boolean {
  return fromEnv() !== undefined && storedNotifyPolicy() !== undefined;
}

function entryOf(scope: ActivityPolicyScope | undefined, type: string): ActivityPolicyEntry | undefined {
  const entry = scope?.[type];
  return plainObject(entry) ? entry as ActivityPolicyEntry : undefined;
}

/**
 * Which of the three scopes answered — `builtin` when none of them did.
 *
 * Reported alongside the value because "почему тихо" is not answerable from the value alone: an
 * event muted by the project's `mute: true` and one muted by the built-in default look identical
 * on a phone, and the two are undone in different places.
 */
export type ActivityPolicyScopeName = 'pipeline' | 'project' | 'defaults' | 'builtin';

export interface ResolvedActivityChannel<T extends string> {
  mode: T;
  scope: ActivityPolicyScopeName;
  /** True when the scope said nothing about this type and its `mute: true` decided instead. */
  byMute: boolean;
}

export interface ActivityPolicyExplanation {
  push: ResolvedActivityChannel<ActivityPushMode>;
  dashboard: ResolvedActivityChannel<ActivityDashboardMode>;
}

/** The scopes in resolution order, named — one list, so the two resolvers cannot disagree. */
function scopeChain(
  document: NotifyPolicyDocument,
  projectId?: string | null,
  pipelineSpecId?: string | null,
): Array<{ name: ActivityPolicyScopeName; scope: ActivityPolicyScope | undefined }> {
  return [
    { name: 'pipeline', scope: pipelineSpecId ? document.pipelines?.[pipelineSpecId] : undefined },
    { name: 'project', scope: projectId ? document.projects?.[projectId] : undefined },
    { name: 'defaults', scope: document.defaults },
  ];
}

function resolveChannel<T extends string>(
  scopes: Array<{ name: ActivityPolicyScopeName; scope: ActivityPolicyScope | undefined }>,
  type: string,
  channel: 'push' | 'dashboard',
  builtin: T,
): ResolvedActivityChannel<T> {
  for (const { name, scope } of scopes) {
    if (!scope) continue;
    const explicit = entryOf(scope, type)?.[channel];
    if (explicit !== undefined) return { mode: explicit as T, scope: name, byMute: false };
    if (scope.mute === true) return { mode: 'off' as T, scope: name, byMute: true };
  }
  return { mode: builtin, scope: 'builtin', byMute: false };
}

/**
 * The delivery decision for one event against a given document: scopes from specific to general,
 * per channel. Events with no run (hence no known pipeline) simply skip the pipeline scope.
 *
 * Taking the document as an argument is what lets an editor answer "and what would apply if this
 * scope's entry were removed" — resolve the same type against a copy without that entry.
 */
export function resolveActivityPolicy(
  document: NotifyPolicyDocument,
  type: string,
  projectId?: string | null,
  pipelineSpecId?: string | null,
): ActivityChannelPolicy {
  const builtin = builtinActivityDefaults()[type];
  if (!builtin) throw new Error(`Unknown activity type "${type}"`);
  const explained = explainActivityPolicy(document, type, projectId, pipelineSpecId);
  return { push: explained.push.mode, dashboard: explained.dashboard.mode };
}

/**
 * The same decision, plus the scope that made it — what an inbox row needs to say "пуш выключен
 * правилом проекта" and to offer the switch that undoes exactly that rule.
 */
export function explainActivityPolicy(
  document: NotifyPolicyDocument,
  type: string,
  projectId?: string | null,
  pipelineSpecId?: string | null,
): ActivityPolicyExplanation {
  const builtin = builtinActivityDefaults()[type];
  if (!builtin) throw new Error(`Unknown activity type "${type}"`);
  const scopes = scopeChain(document, projectId, pipelineSpecId);
  return {
    push: resolveChannel(scopes, type, 'push', builtin.push),
    dashboard: resolveChannel(scopes, type, 'dashboard', builtin.dashboard),
  };
}

/** The decision in force right now: `resolveActivityPolicy` against the document actually stored. */
export function effectiveActivityPolicy(
  type: string,
  projectId: string,
  pipelineSpecId?: string | null,
): ActivityChannelPolicy {
  return resolveActivityPolicy(notifyPolicy(), type, projectId, pipelineSpecId);
}

/** `explainActivityPolicy` against the document actually in force. */
export function effectiveActivityPolicyExplained(
  type: string,
  projectId: string,
  pipelineSpecId?: string | null,
): ActivityPolicyExplanation {
  return explainActivityPolicy(notifyPolicy(), type, projectId, pipelineSpecId);
}
