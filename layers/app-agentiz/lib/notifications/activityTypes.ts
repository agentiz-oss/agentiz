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
  /**
   * The chip an actionable row is marked with, two or three words at most — the inbox card has one
   * line for it next to the task's name. Lives here rather than in the clients so a phone, the
   * panel and a future channel spell the same event the same way.
   */
  badge: string;
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
    badge: 'вопрос',
  },
  {
    type: 'proposal.waiting_review',
    kind: 'action_required',
    defaults: { push: 'on', dashboard: 'on' },
    androidChannel: ANDROID_CHANNEL_ACTIONS,
    label: 'Изменения ждут ревью',
    badge: 'ревью',
  },
  {
    type: 'proposal.push_failed',
    kind: 'action_required',
    defaults: { push: 'on', dashboard: 'on' },
    androidChannel: ANDROID_CHANNEL_ACTIONS,
    label: 'Push изменений не удался',
    badge: 'push не прошёл',
  },
  {
    type: 'proposal.reset_failed',
    kind: 'action_required',
    defaults: { push: 'on', dashboard: 'on' },
    androidChannel: ANDROID_CHANNEL_ACTIONS,
    label: 'Сброс воркспейса не удался',
    badge: 'сброс не прошёл',
  },
  {
    /**
     * The machine an agent runs on has lost its authorization (Claude logged out, an OAuth token
     * past renewal) and every stage of that harness is parked until a person logs in again — see
     * `HarnessAuthState`. `action_required` and `push: on` because it is the one blocker nobody
     * inside Agentiz can clear: the fix is a browser on the worker machine, and until it happens
     * the queue just silently stops moving.
     *
     * One row per parked run rather than one per broken machine: an activity belongs to a
     * project, and what a person actually needs to hear is that *their* task is not running.
     */
    type: 'harness.auth_required',
    kind: 'action_required',
    defaults: { push: 'on', dashboard: 'on' },
    androidChannel: ANDROID_CHANNEL_ACTIONS,
    label: 'Нужен повторный вход в harness на воркере',
    badge: 'нужен вход',
  },
  {
    type: 'run.held_for_approval',
    kind: 'action_required',
    defaults: { push: 'on', dashboard: 'on' },
    androidChannel: ANDROID_CHANNEL_ACTIONS,
    label: 'Изменения удержаны до одобрения',
    badge: 'ждёт одобрения',
  },
  {
    /**
     * A person has to accept (or send back) the work itself — the human gate of a workflow, see
     * `.ai-notes/human-in-the-loop-workflow-plan.md` §7. Distinct from `run.held_for_approval`,
     * which is about a *diff* waiting to be committed: this one is about the feature being right,
     * and it is addressed to whoever carries `agentiz-approval-decide` in the project rather than
     * to everybody in it.
     */
    type: 'approval.requested',
    kind: 'action_required',
    defaults: { push: 'on', dashboard: 'on' },
    androidChannel: ANDROID_CHANNEL_ACTIONS,
    label: 'Требуется решение человека',
    badge: 'решение',
  },
  {
    /** The decision itself, as news for everybody who was not the one who made it. */
    type: 'approval.decided',
    kind: 'info',
    defaults: { push: 'silent', dashboard: 'on' },
    androidChannel: ANDROID_CHANNEL_RESULTS,
    label: 'Решение по приёмке принято',
    badge: 'решено',
  },
  {
    type: 'pr.opened',
    kind: 'action_required',
    defaults: { push: 'on', dashboard: 'on' },
    androidChannel: ANDROID_CHANNEL_ACTIONS,
    label: 'Открыт pull request',
    badge: 'pull request',
  },
  {
    type: 'run.failed',
    kind: 'info',
    defaults: { push: 'on', dashboard: 'on' },
    androidChannel: ANDROID_CHANNEL_FAILURES,
    label: 'Запуск завершился с ошибкой',
    badge: 'ошибка',
  },
  {
    type: 'run.succeeded',
    kind: 'info',
    defaults: { push: 'silent', dashboard: 'on' },
    androidChannel: ANDROID_CHANNEL_RESULTS,
    label: 'Запуск завершился успешно',
    badge: 'готово',
  },
  {
    type: 'proposal.pushed',
    kind: 'info',
    defaults: { push: 'silent', dashboard: 'on' },
    androidChannel: ANDROID_CHANNEL_RESULTS,
    label: 'Изменения закоммичены и запушены',
    badge: 'запушено',
  },
  {
    /**
     * A repository fact, journalled for the same reason every other event is: without a feed row
     * "в репозитории запушили, а флоу не стартовал" has no evidence on either side. Delivery is
     * `silent` by default — a push happens whenever somebody else feels like it, and a repository
     * that is merely busy must not wake a phone; a project that wants to be woken raises it in the
     * policy.
     */
    type: 'repository.pushed',
    kind: 'info',
    defaults: { push: 'silent', dashboard: 'on' },
    androidChannel: ANDROID_CHANNEL_RESULTS,
    label: 'В репозиторий пришли коммиты',
    badge: 'коммиты',
  },
  {
    /**
     * One type for every outcome, not one per conclusion: the catalogue is what the policy schema
     * and the UI hints are generated from, and it must not grow a row per CI verdict. *Which*
     * outcome it was is in the row's own title and `data.conclusion`.
     */
    type: 'repository.ci_run',
    kind: 'info',
    defaults: { push: 'silent', dashboard: 'on' },
    androidChannel: ANDROID_CHANNEL_RESULTS,
    label: 'Завершился CI-прогон',
    badge: 'CI',
  },
  {
    /**
     * One type for every package ecosystem and both actions (`published`/`updated`), same rule as
     * the CI one above: *what* was published is in the row's title and `data.tag`/`data.digest`.
     * Silent by default because a repository that builds an image on every merge would otherwise
     * buzz a phone for its own routine.
     */
    type: 'repository.package',
    kind: 'info',
    defaults: { push: 'silent', dashboard: 'on' },
    androidChannel: ANDROID_CHANNEL_RESULTS,
    label: 'Опубликован пакет репозитория',
    badge: 'пакет',
  },
  {
    type: 'run.cancelled',
    kind: 'info',
    defaults: { push: 'off', dashboard: 'off' },
    androidChannel: ANDROID_CHANNEL_RESULTS,
    label: 'Запуск отменён',
    badge: 'отменён',
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
