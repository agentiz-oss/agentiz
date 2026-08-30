/**
 * The one catalogue of Agentiz permission tokens and of the role presets built out of them.
 *
 * Everything that has an opinion about rights reads this file and nothing else: token
 * registration in `AppAgentiz.mount()`, the seeding of the role groups (`roleSeed.ts`), the
 * project-scoped checks (`projectAccess.ts`), the members screen and MCP. The discipline is the
 * one `activityTypes.ts` and `hookEnv.ts` already follow — a second list somewhere else is how
 * "роль есть, а прав нет" happens, and it never shows up in a log.
 *
 * Two kinds of token live here and they are checked in two different places:
 *
 * - **Model CRUD tokens** (`read-agenttask-model`, …) are read by adminizer: globally by
 *   `AccessRightsHelper` (the upper bound — no token in the user's *own* groups, no section) and
 *   per project by the access graph, which counts a membership row only for actions whose CRUD
 *   token the row's group carries.
 * - **Semantic tokens** (`agentiz-*`) are ours. The graph never reads them; `projectAccess.can()`
 *   does. The graph decides *which rows*, we decide *which actions*.
 *
 * Case matters and only in one direction. `registerToken` lowercases ids, and the graph compares
 * a plain string grant case-insensitively while `AccessRightsHelper.hasAssignedPermission`
 * compares it exactly — so `Read-AgentTask-Model` in a group would pass the graph and fail the
 * global check, giving "участник видит список, но не может войти в раздел" with nothing in the
 * log. Hence: every id in this file is written lowercase, and `tokens.test.ts` fails the build if
 * one is not.
 */

/** Where these tokens land in the panel's group editor. */
export const AGENTIZ_TOKEN_DEPARTMENT = 'Agentiz';

/**
 * The models covered by the `agentiz` access graph, root first (see `config/adminizer.ts`). Their
 * CRUD tokens are what a role group carries, so this list is also the alphabet the presets below
 * are written in.
 */
export const AGENTIZ_GRAPH_MODELS = [
  'AgentProject',
  'AgentTask',
  'AgentRun',
  'AgentRunLog',
  'AgentRunDiff',
  'AgentRunInteraction',
  'AgentRunJob',
  'AgentWorkspaceProposal',
  'AgentProjectRepository',
  'AgentTaskSource',
  'PipelineSpec',
  'AgentRole',
  'AgentActivity',
  'AgentTaskComment',
  'AgentTaskAttachment',
  'AgentStageExecution',
] as const;

export type AgentizGraphModel = (typeof AGENTIZ_GRAPH_MODELS)[number];

export const CRUD_VERBS = ['create', 'read', 'update', 'delete'] as const;
export type CrudVerb = (typeof CRUD_VERBS)[number];

/**
 * `<verb>-<resource>-model`, lowercased — the exact string `modelCrudToken` builds inside
 * adminizer (`src/lib/access-graph/shared.ts`). `resource` is the name the model is registered
 * under, i.e. our `@AdminizerModel({ model: 'AgentTask' })`, which is why the token reads
 * `read-agenttask-model` and not `read-AgentTask-model`.
 *
 * One generator serves seeding, the catalogue and the members screen on purpose: the day these
 * drift, a role still exists and grants nothing.
 */
export function modelCrudToken(verb: CrudVerb, modelName: string): string {
  return `${verb}-${modelName}-model`.toLowerCase();
}

/** Every CRUD token of the listed models, for a single verb. */
function crud(verb: CrudVerb, models: readonly string[]): string[] {
  return models.map((model) => modelCrudToken(verb, model));
}

/**
 * Project-scoped capabilities. They mean something only where the person has a membership row,
 * and they are answered by `projectAccess.can()` — never by `checkPermission`, which sees global
 * groups only and role groups are deliberately not among those.
 */
export const PROJECT_TOKENS = {
  /** See the project and everything inside it. */
  read: 'agentiz-project-read',
  /** Create, edit and comment on tasks. */
  taskWrite: 'agentiz-task-write',
  /** Start and cancel runs, answer the agent. */
  runOperate: 'agentiz-run-operate',
  /** Approve diffs (AgentWorkspaceProposal). */
  diffReview: 'agentiz-diff-review',
  /** Accept the work itself — deliberately a different token from `diffReview`. */
  approvalDecide: 'agentiz-approval-decide',
  /** Pipelines, workflows, repositories, project settings. */
  projectConfigure: 'agentiz-project-configure',
  /** Add a person to the project, change their role, remove them. */
  projectMembers: 'agentiz-project-members',
} as const;

export type ProjectToken = (typeof PROJECT_TOKENS)[keyof typeof PROJECT_TOKENS];

/**
 * Tokens that mean the same thing everywhere and therefore live in a person's ordinary groups.
 * `projectAdmin` is the graph's `bypassToken`: adminizer matches it against `user.groups` only,
 * so putting it on a *role* group does nothing — a role must not be able to widen its own
 * project boundary.
 */
export const GLOBAL_TOKENS = {
  /** The Agentiz sections in the navigation. */
  access: 'agentiz-access',
  projectCreate: 'agentiz-project-create',
  /** Support: sees every project of the graph, membership or not. */
  projectAdmin: 'agentiz-project-admin',
  workersManage: 'agentiz-workers-manage',
  connectionsManage: 'agentiz-connections-manage',
  notificationsManage: 'agentiz-notifications-manage',
  /** Manage membership rows anywhere — the global counterpart of `PROJECT_TOKENS.projectMembers`. */
  projectMembers: 'agentiz-project-members',
} as const;

export type GlobalToken = (typeof GLOBAL_TOKENS)[keyof typeof GLOBAL_TOKENS];

interface TokenDescription {
  id: string;
  name: string;
  description: string;
}

/** What the group editor shows next to each semantic token. */
export const AGENTIZ_TOKEN_CATALOGUE: TokenDescription[] = [
  { id: PROJECT_TOKENS.read, name: 'Проект: чтение', description: 'Видеть проект и всё, что в нём' },
  { id: PROJECT_TOKENS.taskWrite, name: 'Проект: задачи', description: 'Создавать, править и комментировать задачи' },
  { id: PROJECT_TOKENS.runOperate, name: 'Проект: запуски', description: 'Запускать и отменять запуски, отвечать агенту' },
  { id: PROJECT_TOKENS.diffReview, name: 'Проект: ревью дифов', description: 'Утверждать и отклонять предложенные изменения' },
  { id: PROJECT_TOKENS.approvalDecide, name: 'Проект: приёмка', description: 'Принимать работу по задаче' },
  { id: PROJECT_TOKENS.projectConfigure, name: 'Проект: настройка', description: 'Пайплайны, воркфлоу, репозитории, параметры проекта' },
  { id: PROJECT_TOKENS.projectMembers, name: 'Проект: участники', description: 'Добавлять людей в проект, менять роли, убирать' },
  { id: GLOBAL_TOKENS.access, name: 'Agentiz: доступ', description: 'Разделы Agentiz в навигации' },
  { id: GLOBAL_TOKENS.projectCreate, name: 'Agentiz: создание проектов', description: 'Заводить новые проекты' },
  { id: GLOBAL_TOKENS.projectAdmin, name: 'Agentiz: администратор проектов', description: 'Видеть все проекты, минуя членство (техподдержка)' },
  { id: GLOBAL_TOKENS.workersManage, name: 'Agentiz: воркеры', description: 'Регистрация машин, токены, разрешения' },
  { id: GLOBAL_TOKENS.connectionsManage, name: 'Agentiz: подключения', description: 'Git-подключения и зеркалирование репозиториев' },
  { id: GLOBAL_TOKENS.notificationsManage, name: 'Agentiz: уведомления', description: 'Общие правила доставки уведомлений' },
];

/** The registration payload adminizer's `accessRightsHelper.registerTokens` expects. */
export function agentizAccessRightTokens(): Array<TokenDescription & { department: string }> {
  return AGENTIZ_TOKEN_CATALOGUE.map((token) => ({ ...token, department: AGENTIZ_TOKEN_DEPARTMENT }));
}

/* ------------------------------------------------------------------------------------------- */

export interface RolePreset {
  /** Stable key — used by the members screen to label a group whose token set matches. */
  key: string;
  /** Group name as seeded; a group is matched by name, never re-created. */
  name: string;
  description: string;
  tokens: string[];
}

const READ_ALL = crud('read', AGENTIZ_GRAPH_MODELS);

/** What a person writes when they only own the task: the task, its comments and its files. */
const TASK_MODELS = ['AgentTask', 'AgentTaskComment', 'AgentTaskAttachment'] as const;
/** What a person writes when they drive the work itself. */
const RUN_MODELS = ['AgentRun', 'AgentRunDiff', 'AgentRunInteraction', 'AgentWorkspaceProposal'] as const;
/** What a person writes when they configure the project. */
const CONFIG_MODELS = ['PipelineSpec', 'AgentRole', 'AgentProjectRepository', 'AgentTaskSource'] as const;

function ladder(steps: Array<Omit<RolePreset, 'tokens'> & { adds: string[] }>): RolePreset[] {
  const presets: RolePreset[] = [];
  const carried: string[] = [];
  for (const step of steps) {
    for (const token of step.adds) if (!carried.includes(token)) carried.push(token);
    const { adds: _adds, ...rest } = step;
    presets.push({ ...rest, tokens: [...carried] });
  }
  return presets;
}

/**
 * The role ladder, in the sense GitLab's is one: Guest → Reporter → Developer → Maintainer →
 * Owner. Each step carries everything the previous one carries and adds its own — which is why
 * `ladder()` accumulates rather than each preset listing its whole set.
 *
 * The nesting is not decoration. It buys three things and costs only discipline here: "повысить
 * роль" is picking a row lower down rather than diffing checkboxes; "Особая роль" on the members
 * screen means exactly "не совпало ни с одной ступенью" rather than "непонятно что"; and «этот
 * человек может меньше того?» is a comparison of positions. `tokens.test.ts` asserts it, because
 * the ladder would otherwise come apart on the first edit to this file, silently.
 *
 * A consequence worth naming: `approval-decide` arrives at Тестировщики and is therefore carried
 * by Разработчики too. The two tokens stay separate so that accepting work can be given to
 * somebody who cannot review diffs at all — the practice of "свой диф разработчик утверждает сам,
 * а «фича принята» говорит другой человек" is a matter of which role you hand out, not of a hole
 * in the ladder.
 */
export const ROLE_PRESETS: RolePreset[] = ladder([
  {
    key: 'observer',
    name: 'Agentiz · Наблюдатели',
    description: 'Видит проект и всё в нём, ничего не меняет',
    adds: [...READ_ALL, PROJECT_TOKENS.read, 'notification-agentiz'],
  },
  {
    key: 'customer',
    name: 'Agentiz · Заказчики',
    description: 'Ставит задачи и комментирует их',
    adds: [
      modelCrudToken('create', 'AgentTask'),
      modelCrudToken('update', 'AgentTask'),
      modelCrudToken('create', 'AgentTaskComment'),
      modelCrudToken('create', 'AgentTaskAttachment'),
      PROJECT_TOKENS.taskWrite,
    ],
  },
  {
    key: 'tester',
    name: 'Agentiz · Тестировщики',
    description: 'Запускает пайплайны и принимает работу',
    adds: [modelCrudToken('create', 'AgentRun'), PROJECT_TOKENS.runOperate, PROJECT_TOKENS.approvalDecide],
  },
  {
    key: 'developer',
    name: 'Agentiz · Разработчики',
    description: 'Ведёт задачи и запуски, утверждает дифы',
    adds: [...crud('create', [...TASK_MODELS, ...RUN_MODELS]), ...crud('update', [...TASK_MODELS, ...RUN_MODELS]), PROJECT_TOKENS.diffReview],
  },
  {
    key: 'maintainer',
    name: 'Agentiz · Мейнтейнеры',
    description: 'Настраивает пайплайны, роли и репозитории проекта, ведёт состав участников',
    adds: [
      ...crud('create', CONFIG_MODELS),
      ...crud('update', CONFIG_MODELS),
      ...crud('delete', CONFIG_MODELS),
      ...crud('delete', [...TASK_MODELS, ...RUN_MODELS]),
      modelCrudToken('update', 'AgentProject'),
      PROJECT_TOKENS.projectConfigure,
      PROJECT_TOKENS.projectMembers,
    ],
  },
  {
    key: 'owner',
    name: 'Agentiz · Владелец',
    description: 'Всё, что можно делать внутри проекта',
    adds: [
      ...CRUD_VERBS.flatMap((verb) => crud(verb, AGENTIZ_GRAPH_MODELS)),
      ...Object.values(PROJECT_TOKENS),
    ],
  },
]);

/** The preset a project's owner is given a membership row with (see `roleSeed.ts`). */
export const OWNER_ROLE_KEY = 'owner';

export function ownerRolePreset(): RolePreset {
  const preset = ROLE_PRESETS.find((item) => item.key === OWNER_ROLE_KEY);
  if (!preset) throw new Error('[app-agentiz] the owner role preset is missing from ROLE_PRESETS');
  return preset;
}

/**
 * The upper bound, as a group to hand a person when their account is created. The graph narrows
 * visibility; it never grants what the global token gate denied, so without these tokens in an
 * *ordinary* group a role group opens nothing and the symptom is a section rendered with no
 * fields at all (`getFieldsConfig` refuses).
 *
 * `AgentProjectMember` is deliberately not in it: whoever may read membership rows may read them
 * in every project, since the model is outside the graph (see models/AgentProjectMember.ts).
 */
export const ACCESS_GROUP: RolePreset = {
  key: 'access',
  name: 'Agentiz · Доступ',
  description: 'Верхняя граница: вход в панель и полный набор модельных прав Agentiz. Проектные роли её сужают.',
  tokens: [
    'access-to-adminpanel',
    GLOBAL_TOKENS.access,
    'notification-agentiz',
    ...CRUD_VERBS.flatMap((verb) => crud(verb, AGENTIZ_GRAPH_MODELS)),
  ],
};

/** Every group this layer seeds: the role ladder plus the upper-bound group. */
export function seededGroups(): RolePreset[] {
  return [...ROLE_PRESETS, ACCESS_GROUP];
}
