/**
 * The catalogue of activity types — the single source every other piece derives from.
 *
 * Same principle as `lib/hookEnv.ts`: the dispatcher validates against it, the policy slot's JSON
 * schema is generated from it, the built-in delivery defaults live on it and the admin/mobile UIs
 * read it for hints. Adding a type anywhere else silently splits those consumers apart, so don't:
 * a new event gets one entry here and nothing more.
 *
 * `kind` is denormalized onto every AgentActivity row for selects; `defaults` is the built-in
 * delivery policy that applies when no scope of AGENTIZ_NOTIFY_POLICY says otherwise
 * (see policySettings.ts). `push: 'silent'` means "deliver, but do not wake anyone": normal
 * priority, Android low-importance channel, no sound.
 */

export type ActivityKind = 'action_required' | 'info';
export type ActivityPushMode = 'on' | 'silent' | 'off';
export type ActivityDashboardMode = 'on' | 'off';

export interface ActivityChannelPolicy {
  push: ActivityPushMode;
  dashboard: ActivityDashboardMode;
}

export interface ActivityTypeDef {
  type: string;
  kind: ActivityKind;
  /** Built-in delivery defaults — the last resort of the policy resolution chain. */
  defaults: ActivityChannelPolicy;
  /** Android notification channel a `push: on` delivery goes to (silent always goes to results). */
  androidChannel: string;
  /** One line for settings UIs; user-facing, hence Russian like the rest of the panel. */
  label: string;
}

/** Android channels, referenced here and registered by the mobile client. */
export const ANDROID_CHANNEL_INTERACTIONS = 'agentiz-interactions';
export const ANDROID_CHANNEL_ACTIONS = 'agentiz-actions';
export const ANDROID_CHANNEL_FAILURES = 'agentiz-failures';
export const ANDROID_CHANNEL_RESULTS = 'agentiz-results';

const DEFS: ActivityTypeDef[] = [
  {
    type: 'interaction.created',
    kind: 'action_required',
    defaults: { push: 'on', dashboard: 'on' },
    androidChannel: ANDROID_CHANNEL_INTERACTIONS,
    label: 'Агент задал вопрос',
  },
  {
    type: 'proposal.waiting_review',
    kind: 'action_required',
    defaults: { push: 'on', dashboard: 'on' },
    androidChannel: ANDROID_CHANNEL_ACTIONS,
    label: 'Изменения ждут ревью',
  },
  {
    type: 'proposal.push_failed',
    kind: 'action_required',
    defaults: { push: 'on', dashboard: 'on' },
    androidChannel: ANDROID_CHANNEL_ACTIONS,
    label: 'Push изменений не удался',
  },
  {
    type: 'proposal.reset_failed',
    kind: 'action_required',
    defaults: { push: 'on', dashboard: 'on' },
    androidChannel: ANDROID_CHANNEL_ACTIONS,
    label: 'Сброс воркспейса не удался',
  },
  {
    type: 'run.held_for_approval',
    kind: 'action_required',
    defaults: { push: 'on', dashboard: 'on' },
    androidChannel: ANDROID_CHANNEL_ACTIONS,
    label: 'Изменения удержаны до одобрения',
  },
  {
    type: 'pr.opened',
    kind: 'action_required',
    defaults: { push: 'on', dashboard: 'on' },
    androidChannel: ANDROID_CHANNEL_ACTIONS,
    label: 'Открыт pull request',
  },
  {
    type: 'run.failed',
    kind: 'info',
    defaults: { push: 'on', dashboard: 'on' },
    androidChannel: ANDROID_CHANNEL_FAILURES,
    label: 'Запуск завершился с ошибкой',
  },
  {
    type: 'run.succeeded',
    kind: 'info',
    defaults: { push: 'silent', dashboard: 'on' },
    androidChannel: ANDROID_CHANNEL_RESULTS,
    label: 'Запуск завершился успешно',
  },
  {
    type: 'proposal.pushed',
    kind: 'info',
    defaults: { push: 'silent', dashboard: 'on' },
    androidChannel: ANDROID_CHANNEL_RESULTS,
    label: 'Изменения закоммичены и запушены',
  },
  {
    type: 'run.cancelled',
    kind: 'info',
    defaults: { push: 'off', dashboard: 'off' },
    androidChannel: ANDROID_CHANNEL_RESULTS,
    label: 'Запуск отменён',
  },
];

export type ActivityType = typeof DEFS[number]['type'];

const BY_TYPE: ReadonlyMap<string, ActivityTypeDef> = new Map(DEFS.map((def) => [def.type, def]));

export function activityTypes(): readonly ActivityTypeDef[] {
  return DEFS;
}

export function isActivityType(type: string): boolean {
  return BY_TYPE.has(type);
}

/** The definition, or a throw — an unknown type is a programming error, not an input to tolerate. */
export function activityTypeDef(type: string): ActivityTypeDef {
  const def = BY_TYPE.get(type);
  if (!def) throw new Error(`Unknown activity type "${type}" — add it to lib/notifications/activityTypes.ts first`);
  return def;
}

/** Built-in delivery defaults per type — the tail of every policy resolution. */
export function builtinActivityDefaults(): Record<string, ActivityChannelPolicy> {
  return Object.fromEntries(DEFS.map((def) => [def.type, { ...def.defaults }]));
}
