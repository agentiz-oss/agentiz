/**
 * Демо-проект для проверки приложения в App Store / Google Play.
 *
 * Ревьюеру магазина нужен работающий аккаунт, а показывать ему чужие проекты нельзя — поэтому
 * здесь собран **отдельный проект с выдуманными данными**: задачи, завершённые и упавшие запуски
 * со стадиями и логом, тред комментариев, лента событий, один вопрос агента и одна заявка на
 * приёмку. Ничего из этого не связано с настоящей инфраструктурой: воркер не участвует, репозиторий
 * вымышленный, роли исполняются `stub`-исполнителем, а демо-воркфлоу лежит **выключенным**.
 *
 * Почему это не сид и не миграция. Сиды на проде жёстко выключены (`index.ts`, `FORCE_SEED`), а
 * переменные окружения прод-хоста отсюда не меняются; миграция же выполняется один раз и не даёт
 * обновить демо после того, как ревьюер в нём что-то понажимал. Поэтому точка входа — MCP-действие
 * `agentiz.seedDemo` (`mcp/agentizDemoTools.ts`), которое вызывается по требованию и идемпотентно:
 * все строки имеют **фиксированные id с префиксом `demo-`**, так что повторный вызов обновляет их
 * на месте, а `reset` удаляет ровно их и ничего больше.
 *
 * Два правила, которые здесь важнее красоты данных:
 *
 * 1. **Ничего не должно ждать воркера.** Все `AgentRunJob` демо-запусков записаны в `succeeded` —
 *    `AgentJobReaperService` подметает только `leased`/`running`/`released`, и «живая» на вид
 *    запись очереди иначе через четверть часа осиротила бы вопрос агента, ради которого она и
 *    существует. По той же причине здесь нет ни удерживаемого диффа, ни `AgentWorkspaceProposal`:
 *    у них кнопки, которые без воркера ответят ошибкой.
 * 2. **То, что ревьюер может нажать, должно отработать.** Ответ на вопрос агента
 *    (`AgentRunInteractionService.answer`) и решение по заявке (`ApprovalService.decide`) пишут
 *    только в базу: воркфлоу у заявки нет (`workflowRunId: null`), продолжать нечего, ошибки не
 *    будет. Запуск пайплайна кнопкой «Запустить» — единственное, что упрётся в отсутствие воркера:
 *    задача встанет в очередь и останется в ней, это ожидаемое поведение демо.
 *
 * Строки пишутся моделями напрямую, а не сервисами, сознательно: `ActivityService.record()` разослал
 * бы пуши на настоящие телефоны, а хук `@AfterUpdate` на `AgentRun` разбудил бы мост воркфлоу.
 * Создание через `create()` терминальных строк ни того, ни другого не делает.
 */

import { Op } from 'sequelize';
import { AgentActivity } from '../../models/AgentActivity';
import { AgentApprovalRequest } from '../../models/AgentApprovalRequest';
import { AgentProject } from '../../models/AgentProject';
import { AgentRole } from '../../models/AgentRole';
import { AgentRun } from '../../models/AgentRun';
import { AgentRunInteraction } from '../../models/AgentRunInteraction';
import { AgentRunJob } from '../../models/AgentRunJob';
import { AgentRunLog } from '../../models/AgentRunLog';
import { AgentStageExecution } from '../../models/AgentStageExecution';
import { AgentTask } from '../../models/AgentTask';
import { AgentTaskComment } from '../../models/AgentTaskComment';
import { AgentWorkflowSpec } from '../../models/AgentWorkflowSpec';
import { PipelineSpec } from '../../models/PipelineSpec';

/** Слаг демо-проекта. Ищется по нему, а не по id: проект мог быть заведён руками раньше. */
export const DEMO_PROJECT_SLUG = 'demo';

/** Префикс id всех демо-строк — по нему же работает удаление. */
export const DEMO_ID_PREFIX = 'demo-';

const PROJECT_ID = 'demo-project';
const SPEC_DEFAULT_ID = 'demo-spec-default';
const SPEC_QA_ID = 'demo-spec-qa';
const WORKFLOW_ID = 'demo-workflow-round';

const MINUTE = 60_000;

/** Смещения в данных ниже записаны в минутах «назад от сейчас» — отсюда две сокращающие функции. */
const hours = (value: number): number => value * 60;
const days = (value: number): number => value * 24 * 60;

/** Роли демо-проекта. `executor: 'stub'` — настоящая обвязка агента не нужна и не вызывается. */
const ROLES = [
  {
    id: 'demo-role-analyst',
    key: 'analyst',
    title: 'Аналитик',
    systemPrompt: 'Разбери задачу и опиши, что и где нужно проверить. Ничего не меняй.',
    model: 'claude-sonnet-5',
    allowedTools: ['Read', 'Grep', 'Glob'],
  },
  {
    id: 'demo-role-developer',
    key: 'developer',
    title: 'Разработчик',
    systemPrompt: 'Внеси минимальные правки, которые решают задачу, и опиши их.',
    model: 'claude-opus-5',
    allowedTools: ['Read', 'Edit', 'Bash'],
  },
  {
    id: 'demo-role-reviewer',
    key: 'reviewer',
    title: 'Ревьюер',
    systemPrompt: 'Проверь результат предыдущих стадий и вынеси вердикт.',
    model: 'claude-haiku-4-5-20251001',
    allowedTools: ['Read'],
  },
] as const;

/** Документ `PipelineSpec.spec` основного пайплайна. Он же лежит снапшотом в каждом демо-запуске. */
const DEFAULT_PIPELINE = {
  stages: [
    { order: 1, role: 'analyze', agentRoleKey: 'analyst', onFail: 'stop', runtime: { mode: 'host' } },
    { order: 2, role: 'implement', agentRoleKey: 'developer', onFail: 'stop', runtime: { mode: 'host' } },
    { order: 3, role: 'review', agentRoleKey: 'reviewer', onFail: 'stop', runtime: { mode: 'host' } },
  ],
  finalAction: { type: 'none' },
} as const;

/** Второй пайплайн: одна стадия и машинный вердикт — им маршрутизируются задачи с тегом `qa`. */
const QA_PIPELINE = {
  stages: [
    { order: 1, role: 'review', agentRoleKey: 'reviewer', onFail: 'stop', verdict: true, runtime: { mode: 'host' } },
  ],
  finalAction: { type: 'none' },
} as const;

/**
 * Демо-воркфлоу: круг «задача → пайплайн → человек принимает». Сохраняется **выключенным**
 * (`active: false`) — граф на канвасе видно, но ни один триггер не взведён, и демо-данные не
 * начинают сами себя запускать.
 */
function demoWorkflowGraph(projectId: string) {
  return {
    id: WORKFLOW_ID,
    name: 'Демо: задача → пайплайн → приёмка',
    active: false,
    nodes: [
      { id: 'arrived', type: 'agentiz.task.trigger', config: { event: 'agentiz.task.created', projectId }, ui: { x: 0, y: 0 } },
      { id: 'worth', type: 'agentiz.task.match', config: { keywords: 'демо', tags: 'feature', fields: 'both', require: 'any' }, ui: { x: 260, y: 0 } },
      { id: 'run', type: 'agentiz.pipeline', config: { trigger: 'sync', specId: SPEC_DEFAULT_ID }, ui: { x: 520, y: 0 } },
      {
        id: 'accept',
        type: 'agentiz.approval',
        config: { title: 'Принять работу?', message: 'Агент закончил. Посмотрите результат и примите решение.' },
        ui: { x: 780, y: 0 },
      },
      { id: 'accepted', type: 'agentiz.task.status', config: { text: 'Принято', alsoComment: true }, ui: { x: 1040, y: -80 } },
      {
        id: 'rework',
        type: 'agentiz.task.comment',
        config: { body: '{{payload.comment}}', authorKind: 'human', releasesTask: true },
        ui: { x: 1040, y: 80 },
      },
    ],
    edges: [
      { from: 'arrived', to: 'worth' },
      { from: 'worth', fromPort: 'match', to: 'run' },
      { from: 'run', fromPort: 'succeeded', to: 'accept' },
      { from: 'accept', fromPort: 'approved', to: 'accepted' },
      { from: 'accept', fromPort: 'rejected', to: 'rework' },
    ],
    entity: { model: 'AgentProject', id: projectId },
  };
}

interface DemoStage {
  index: number;
  role: string;
  roleId: string;
  status: 'succeeded' | 'failed' | 'waiting_input' | 'pending';
  summary?: string;
  error?: string;
  startedMinutes: number;
  finishedMinutes: number | null;
}

interface DemoLog {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  stage?: number;
  minutes: number;
}

interface DemoRun {
  id: string;
  status: 'succeeded' | 'failed' | 'waiting_input';
  startedMinutes: number;
  finishedMinutes: number | null;
  summary: string | null;
  error?: string | null;
  branch?: string | null;
  commitSha?: string | null;
  verdict?: 'pass' | 'fail' | null;
  verdictReason?: string | null;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number };
  pipeline: typeof DEFAULT_PIPELINE | typeof QA_PIPELINE;
  stages: DemoStage[];
  logs: DemoLog[];
}

interface DemoComment {
  id: string;
  authorKind: 'human' | 'agent' | 'system';
  authorName: string;
  body: string;
  runId?: string;
  minutes: number;
}

interface DemoTask {
  id: string;
  externalId: string;
  title: string;
  description: string;
  status: 'new' | 'queued' | 'running' | 'waiting_input' | 'waiting_review' | 'done' | 'failed' | 'cancelled';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  tags: string[];
  specId: string;
  createdMinutes: number;
  /** Когда по задаче в последний раз что-то произошло: доска сортируется по этому полю. */
  updatedMinutes: number;
  runs: DemoRun[];
  comments: DemoComment[];
}

/**
 * Содержимое демо-проекта: вымышленное приложение для заметок. Тексты русские — как и весь
 * интерфейс; ревьюер оценивает работоспособность, а не язык контента.
 */
const TASKS: DemoTask[] = [
  {
    id: 'demo-task-dark-theme',
    externalId: 'DEMO-101',
    title: 'Тёмная тема на экране заметки',
    description:
      'На светлой теме экран заметки читается, на тёмной — текст сливается с фоном карточки.\n' +
      'Нужно взять цвета из палитры темы, а не задавать их в разметке экрана.',
    status: 'done',
    priority: 'normal',
    tags: ['feature', 'ui'],
    specId: SPEC_DEFAULT_ID,
    createdMinutes: days(3),
    updatedMinutes: days(2) - 12,
    runs: [
      {
        id: 'demo-run-dark-theme',
        status: 'succeeded',
        startedMinutes: days(2),
        finishedMinutes: days(2) - 12,
        summary:
          'Цвета экрана заметки переведены на палитру темы: карточка, текст и разделители берут ' +
          'значения из темы приложения. Проверено на светлой и тёмной теме, снапшот-тесты обновлены.',
        branch: 'agentiz/demo-dark-theme',
        commitSha: '9f2c41a8b7d3e05c1a6b8f4d2e7c9a30b5d1f6e8',
        usage: { input: 128_400, output: 9_120, cacheRead: 96_300, cacheWrite: 12_800, costUsd: 0.42 },
        pipeline: DEFAULT_PIPELINE,
        stages: [
          {
            index: 0, role: 'analyze', roleId: 'demo-role-analyst', status: 'succeeded',
            summary: 'Цвета заданы прямо в NoteScreen.kt тремя литералами, палитра темы их не видит.',
            startedMinutes: days(2), finishedMinutes: days(2) - 3,
          },
          {
            index: 1, role: 'implement', roleId: 'demo-role-developer', status: 'succeeded',
            summary: 'Литералы заменены на значения темы, добавлен превью-экран для тёмной темы.',
            startedMinutes: days(2) - 3, finishedMinutes: days(2) - 9,
          },
          {
            index: 2, role: 'review', roleId: 'demo-role-reviewer', status: 'succeeded',
            summary: 'Правки минимальные и по месту, тесты зелёные. Замечаний нет.',
            startedMinutes: days(2) - 9, finishedMinutes: days(2) - 12,
          },
        ],
        logs: [
          { level: 'info', message: 'Run created from spec "Основной пайплайн"', minutes: days(2) },
          { level: 'info', message: 'Worker job queued', minutes: days(2) },
          { level: 'info', message: 'Worker job claimed by demo-worker', minutes: days(2) - 1 },
          { level: 'info', message: 'stage.started: analyze (Аналитик)', stage: 0, minutes: days(2) - 1 },
          { level: 'debug', message: 'stage.tool: Grep "colorScheme" app/src/main', stage: 0, minutes: days(2) - 2 },
          { level: 'debug', message: 'stage.tool: Read app/src/main/ui/NoteScreen.kt', stage: 0, minutes: days(2) - 2 },
          { level: 'info', message: 'stage.completed: analyze', stage: 0, minutes: days(2) - 3 },
          { level: 'info', message: 'stage.started: implement (Разработчик)', stage: 1, minutes: days(2) - 3 },
          { level: 'debug', message: 'stage.tool: Edit app/src/main/ui/NoteScreen.kt', stage: 1, minutes: days(2) - 5 },
          { level: 'debug', message: 'stage.tool: Bash ./gradlew :app:testDebugUnitTest', stage: 1, minutes: days(2) - 7 },
          { level: 'info', message: 'stage.completed: implement', stage: 1, minutes: days(2) - 9 },
          { level: 'info', message: 'stage.started: review (Ревьюер)', stage: 2, minutes: days(2) - 9 },
          { level: 'info', message: 'stage.completed: review', stage: 2, minutes: days(2) - 12 },
          { level: 'info', message: 'Run finished: succeeded', minutes: days(2) - 12 },
        ],
      },
    ],
    comments: [
      {
        id: 'demo-comment-dark-theme-1', authorKind: 'human', authorName: 'Ирина, продакт',
        body: 'На тёмной теме текст заметки почти не виден. Возьмите цвета из темы, пожалуйста.',
        minutes: days(3),
      },
      {
        id: 'demo-comment-dark-theme-2', authorKind: 'agent', authorName: 'Ревьюер',
        body:
          'Готово. Цвета экрана заметки переведены на палитру темы, превью добавлено для обеих тем, ' +
          'снапшот-тесты обновлены. Ветка: agentiz/demo-dark-theme.',
        runId: 'demo-run-dark-theme', minutes: days(2) - 12,
      },
    ],
  },
  {
    id: 'demo-task-search',
    externalId: 'DEMO-102',
    title: 'Поиск не находит слова из заголовков',
    description:
      'Поиск по заметкам ищет только по тексту: заметка с нужным словом в заголовке не находится.\n' +
      'Ожидание — заголовок участвует в поиске наравне с текстом.',
    status: 'waiting_input',
    priority: 'high',
    tags: ['bug'],
    specId: SPEC_DEFAULT_ID,
    createdMinutes: hours(5),
    updatedMinutes: 35,
    runs: [
      {
        id: 'demo-run-search',
        status: 'waiting_input',
        startedMinutes: 40,
        finishedMinutes: null,
        summary: null,
        pipeline: DEFAULT_PIPELINE,
        stages: [
          {
            index: 0, role: 'analyze', roleId: 'demo-role-analyst', status: 'succeeded',
            summary: 'Индекс строится только по полю body; заголовок в него не попадает.',
            startedMinutes: 40, finishedMinutes: 36,
          },
          {
            index: 1, role: 'implement', roleId: 'demo-role-developer', status: 'waiting_input',
            startedMinutes: 36, finishedMinutes: null,
          },
          { index: 2, role: 'review', roleId: 'demo-role-reviewer', status: 'pending', startedMinutes: 0, finishedMinutes: null },
        ],
        logs: [
          { level: 'info', message: 'Run created from spec "Основной пайплайн"', minutes: 40 },
          { level: 'info', message: 'Worker job queued', minutes: 40 },
          { level: 'info', message: 'Worker job claimed by demo-worker', minutes: 39 },
          { level: 'info', message: 'stage.started: analyze (Аналитик)', stage: 0, minutes: 39 },
          { level: 'debug', message: 'stage.tool: Read app/src/main/search/NoteIndex.kt', stage: 0, minutes: 38 },
          { level: 'info', message: 'stage.completed: analyze', stage: 0, minutes: 36 },
          { level: 'info', message: 'stage.started: implement (Разработчик)', stage: 1, minutes: 36 },
          { level: 'warn', message: 'Агент задал вопрос и ждёт ответа человека', stage: 1, minutes: 35 },
        ],
      },
    ],
    comments: [
      {
        id: 'demo-comment-search-1', authorKind: 'human', authorName: 'Ирина, продакт',
        body: 'Воспроизводится на любой заметке: слово есть в заголовке — поиск пустой.',
        minutes: hours(5),
      },
    ],
  },
  {
    id: 'demo-task-export',
    externalId: 'DEMO-103',
    title: 'Экспорт заметок в Markdown',
    description:
      'Нужна кнопка «Экспортировать» на экране списка: выбранные заметки сохраняются одним .md файлом,\n' +
      'заголовок заметки становится заголовком второго уровня.',
    status: 'waiting_review',
    priority: 'normal',
    tags: ['feature'],
    specId: SPEC_DEFAULT_ID,
    createdMinutes: days(2),
    updatedMinutes: hours(5) - 1,
    runs: [
      {
        id: 'demo-run-export',
        status: 'succeeded',
        startedMinutes: hours(6),
        finishedMinutes: hours(5),
        summary:
          'Экспорт готов: кнопка на списке, выбор заметок, сохранение одного .md через системный ' +
          'диалог. Заголовок заметки экспортируется как «## ». Добавлены два теста на формат.',
        branch: 'agentiz/demo-markdown-export',
        commitSha: '4b81de77c0a92f5361ac8e3d77b0c245ef91a3d6',
        verdict: 'pass',
        verdictReason: null,
        usage: { input: 164_800, output: 14_300, cacheRead: 120_500, cacheWrite: 18_400, costUsd: 0.61 },
        pipeline: DEFAULT_PIPELINE,
        stages: [
          {
            index: 0, role: 'analyze', roleId: 'demo-role-analyst', status: 'succeeded',
            summary: 'Экран списка уже умеет выделять заметки — не хватает только действия и сериализации.',
            startedMinutes: hours(6), finishedMinutes: hours(6) - 8,
          },
          {
            index: 1, role: 'implement', roleId: 'demo-role-developer', status: 'succeeded',
            summary: 'Добавлены MarkdownExporter, действие на панели списка и два теста формата.',
            startedMinutes: hours(6) - 8, finishedMinutes: hours(6) - 45,
          },
          {
            index: 2, role: 'review', roleId: 'demo-role-reviewer', status: 'succeeded',
            summary: 'Формат соответствует задаче, экранирование символов на месте. AGENTIZ_VERDICT: pass',
            startedMinutes: hours(6) - 45, finishedMinutes: hours(5),
          },
        ],
        logs: [
          { level: 'info', message: 'Run created from spec "Основной пайплайн"', minutes: hours(6) },
          { level: 'info', message: 'Worker job queued', minutes: hours(6) },
          { level: 'info', message: 'Worker job claimed by demo-worker', minutes: hours(6) - 1 },
          { level: 'info', message: 'stage.started: analyze (Аналитик)', stage: 0, minutes: hours(6) - 1 },
          { level: 'info', message: 'stage.completed: analyze', stage: 0, minutes: hours(6) - 8 },
          { level: 'info', message: 'stage.started: implement (Разработчик)', stage: 1, minutes: hours(6) - 8 },
          { level: 'debug', message: 'stage.tool: Edit app/src/main/export/MarkdownExporter.kt', stage: 1, minutes: hours(6) - 20 },
          { level: 'debug', message: 'stage.tool: Bash ./gradlew :app:testDebugUnitTest', stage: 1, minutes: hours(6) - 40 },
          { level: 'info', message: 'stage.completed: implement', stage: 1, minutes: hours(6) - 45 },
          { level: 'info', message: 'stage.started: review (Ревьюер)', stage: 2, minutes: hours(6) - 45 },
          { level: 'info', message: 'stage.verdict: pass', stage: 2, minutes: hours(5) },
          { level: 'info', message: 'Run finished: succeeded', minutes: hours(5) },
        ],
      },
    ],
    comments: [
      {
        id: 'demo-comment-export-1', authorKind: 'agent', authorName: 'Ревьюер',
        body:
          'Экспорт готов, вердикт — pass. Ветка agentiz/demo-markdown-export. Нужна ваша приёмка: ' +
          'посмотрите формат файла и примите работу или верните с замечанием.',
        runId: 'demo-run-export', minutes: hours(5),
      },
    ],
  },
  {
    id: 'demo-task-sync',
    externalId: 'DEMO-104',
    title: 'Синхронизация падает без сети',
    description:
      'При выключенной сети приложение показывает «Ошибка синхронизации» и перестаёт открывать заметки\n' +
      'до перезапуска. Оффлайн должен работать как обычный режим, а не как ошибка.',
    status: 'failed',
    priority: 'urgent',
    tags: ['bug'],
    specId: SPEC_DEFAULT_ID,
    createdMinutes: hours(30),
    updatedMinutes: hours(26) - 6,
    runs: [
      {
        id: 'demo-run-sync',
        status: 'failed',
        startedMinutes: hours(26),
        finishedMinutes: hours(26) - 6,
        summary: null,
        error: 'Стадия implement завершилась ошибкой: ./gradlew :app:testDebugUnitTest — 2 теста упали (SyncOfflineTest).',
        usage: { input: 72_600, output: 4_400, cacheRead: 41_200, cacheWrite: 6_100, costUsd: 0.19 },
        pipeline: DEFAULT_PIPELINE,
        stages: [
          {
            index: 0, role: 'analyze', roleId: 'demo-role-analyst', status: 'succeeded',
            summary: 'Ошибка сети поднимается до экрана списка и гасит загрузку локальной базы.',
            startedMinutes: hours(26), finishedMinutes: hours(26) - 2,
          },
          {
            index: 1, role: 'implement', roleId: 'demo-role-developer', status: 'failed',
            error: 'SyncOfflineTest: 2 упавших теста после правки обработчика ошибок.',
            startedMinutes: hours(26) - 2, finishedMinutes: hours(26) - 6,
          },
          { index: 2, role: 'review', roleId: 'demo-role-reviewer', status: 'pending', startedMinutes: 0, finishedMinutes: null },
        ],
        logs: [
          { level: 'info', message: 'Run created from spec "Основной пайплайн"', minutes: hours(26) },
          { level: 'info', message: 'Worker job claimed by demo-worker', minutes: hours(26) },
          { level: 'info', message: 'stage.started: analyze (Аналитик)', stage: 0, minutes: hours(26) },
          { level: 'info', message: 'stage.completed: analyze', stage: 0, minutes: hours(26) - 2 },
          { level: 'info', message: 'stage.started: implement (Разработчик)', stage: 1, minutes: hours(26) - 2 },
          { level: 'debug', message: 'stage.tool: Bash ./gradlew :app:testDebugUnitTest', stage: 1, minutes: hours(26) - 4 },
          { level: 'error', message: 'SyncOfflineTest > opensNotesWithoutNetwork FAILED', stage: 1, minutes: hours(26) - 5 },
          { level: 'error', message: 'Run finished: failed', minutes: hours(26) - 6 },
        ],
      },
    ],
    comments: [],
  },
  {
    id: 'demo-task-onboarding',
    externalId: 'DEMO-105',
    title: 'Онбординг: три экрана при первом запуске',
    description:
      'Первый запуск сразу открывает пустой список. Хотим три экрана-приветствия: зачем приложение,\n' +
      'как создать заметку, как включить синхронизацию. Пропускается одной кнопкой.',
    status: 'new',
    priority: 'normal',
    tags: ['feature'],
    specId: SPEC_DEFAULT_ID,
    createdMinutes: 90,
    updatedMinutes: 80,
    runs: [],
    comments: [
      {
        id: 'demo-comment-onboarding-1', authorKind: 'human', authorName: 'Ирина, продакт',
        body: 'Тексты экранов пришлю отдельно, разметку можно делать на заглушках.',
        minutes: 80,
      },
    ],
  },
  {
    id: 'demo-task-a11y',
    externalId: 'DEMO-106',
    title: 'Проверить озвучку списка заметок',
    description:
      'Пройти список заметок скринридером: у карточек нет подписей, дата читается как набор цифр.\n' +
      'Нужен отчёт со списком мест, где подпись отсутствует или бессмысленна.',
    status: 'new',
    priority: 'low',
    tags: ['qa'],
    specId: SPEC_QA_ID,
    createdMinutes: 45,
    updatedMinutes: 45,
    runs: [],
    comments: [],
  },
];

/** Вопрос, на котором стоит запуск `demo-run-search` — строка «требует ответа» во входящих. */
const INTERACTION = {
  id: 'demo-interaction-search',
  runId: 'demo-run-search',
  stageIndex: 1,
  minutes: 35,
  message:
    'Заголовок добавляю в поисковый индекс. Искать ли ещё и по тегам заметки — это меняет размер ' +
    'индекса примерно на треть?',
  requestedSchema: {
    type: 'object',
    required: ['scope'],
    properties: {
      scope: {
        type: 'string',
        title: 'Что включить в поиск',
        enum: ['Только заголовок и текст', 'Заголовок, текст и теги'],
      },
      comment: { type: 'string', title: 'Комментарий (необязательно)' },
    },
  },
};

/** Заявка на приёмку по `demo-task-export` — вторая блокирующая строка во входящих. */
const APPROVAL = {
  id: 'demo-approval-export',
  taskId: 'demo-task-export',
  runId: 'demo-run-export',
  minutes: hours(5),
  title: 'Принять работу: экспорт в Markdown',
  message:
    'Агент закончил экспорт заметок в Markdown, вердикт проверяющей стадии — pass. ' +
    'Примите работу или верните с замечанием: текст замечания получит агент как следующее задание.',
  links: [
    { label: 'Ветка agentiz/demo-markdown-export', url: 'https://example.com/agentiz-demo/notes-app/tree/agentiz/demo-markdown-export' },
  ],
};

interface DemoActivity {
  id: string;
  type: string;
  kind: 'action_required' | 'info';
  taskId: string | null;
  runId: string | null;
  interactionId?: string | null;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  minutes: number;
}

/**
 * Лента событий. Пишется строками, а не через `ActivityService.record()`: диспетчер разослал бы
 * пуши на настоящие устройства, а лента демо-проекта нужна ровно как история.
 * `pr.opened` — единственное событие, у которого нет живой сущности: именно из него строится
 * строка-напоминание «открыт пул-реквест» во входящих.
 */
const ACTIVITIES: DemoActivity[] = [
  {
    id: 'demo-activity-dark-theme-run', type: 'run.succeeded', kind: 'info',
    taskId: 'demo-task-dark-theme', runId: 'demo-run-dark-theme',
    title: 'Запуск завершён: Тёмная тема на экране заметки',
    body: 'Три стадии из трёх, замечаний у ревьюера нет.',
    minutes: days(2) - 12,
  },
  {
    // Напоминание о пул-реквесте живёт, пока открыта **задача**: закрытая задача — это и есть
    // признак, что с PR разобрались (`openPullRequests` в lib/inbox/collect.ts). Поэтому событие
    // висит на задаче, которая ждёт приёмки, а не на уже завершённой.
    id: 'demo-activity-export-pr', type: 'pr.opened', kind: 'action_required',
    taskId: 'demo-task-export', runId: 'demo-run-export',
    title: 'Открыт пул-реквест: Экспорт заметок в Markdown',
    body: 'agentiz/demo-markdown-export → main, 4 файла',
    data: { prUrl: 'https://example.com/agentiz-demo/notes-app/pull/57', branch: 'agentiz/demo-markdown-export' },
    minutes: hours(5) - 1,
  },
  {
    id: 'demo-activity-sync-failed', type: 'run.failed', kind: 'info',
    taskId: 'demo-task-sync', runId: 'demo-run-sync',
    title: 'Запуск упал: Синхронизация падает без сети',
    body: 'Стадия implement: 2 упавших теста (SyncOfflineTest).',
    minutes: hours(26) - 6,
  },
  {
    id: 'demo-activity-export-run', type: 'run.succeeded', kind: 'info',
    taskId: 'demo-task-export', runId: 'demo-run-export',
    title: 'Запуск завершён: Экспорт заметок в Markdown',
    body: 'Вердикт проверяющей стадии — pass.',
    minutes: hours(5),
  },
  {
    id: 'demo-activity-export-approval', type: 'approval.requested', kind: 'action_required',
    taskId: 'demo-task-export', runId: 'demo-run-export',
    title: 'Принять работу: экспорт в Markdown',
    body: 'Агент закончил, нужна приёмка.',
    data: { approvalId: APPROVAL.id },
    minutes: hours(5),
  },
  {
    id: 'demo-activity-search-question', type: 'interaction.created', kind: 'action_required',
    taskId: 'demo-task-search', runId: 'demo-run-search', interactionId: INTERACTION.id,
    title: 'Агент задал вопрос: Поиск не находит слова из заголовков',
    body: 'Искать ли по тегам заметки — это меняет размер индекса.',
    minutes: 35,
  },
];

export interface DemoSeedOptions {
  /** Владелец демо-проекта: он же аккаунт ревьюера магазина. */
  ownerUserId: number;
  /** Снести демо-строки и создать заново — обнуляет то, что ревьюер успел понажимать. */
  reset?: boolean;
  /** Точка отсчёта времени; в тестах фиксируется. */
  now?: Date;
}

export interface DemoSeedResult {
  projectId: string;
  slug: string;
  ownerUserId: number;
  reset: boolean;
  counts: Record<string, number>;
  waitingForPerson: { interactionId: string; approvalId: string };
  tasks: Array<{ id: string; title: string; status: string }>;
}

/**
 * Создаёт строку с фиксированным id или обновляет уже созданную.
 *
 * `createdAt`/`updatedAt` дописываются вторым, **молчащим** сохранением: и `create`, и `update`
 * штампуют `updatedAt` текущим временем поверх переданного, и без этого весь демо-проект читался
 * бы как «всё случилось минуту назад» — задачи в доске сортируются по `updatedAt`, так что
 * пострадал бы и порядок, а не только подпись под строкой.
 */
async function ensure(model: any, id: string, values: Record<string, unknown>): Promise<any> {
  const existing = await model.findByPk(id);
  const row = existing ? (await existing.update(values), existing) : await model.create({ id, ...values });

  const stamps: Record<string, unknown> = {};
  if (values.createdAt instanceof Date) stamps.createdAt = values.createdAt;
  if (values.updatedAt instanceof Date) stamps.updatedAt = values.updatedAt;
  if (Object.keys(stamps).length > 0) {
    // Именно статический `update` с `silent`: у инстансного `save()` эти поля из набора
    // изменённых выбрасываются, и значение уезжает в «сейчас» молча.
    await model.update(stamps, { where: { id }, silent: true });
  }

  return row;
}

function at(now: Date, minutesAgo: number): Date {
  return new Date(now.getTime() - minutesAgo * MINUTE);
}

function stageId(runId: string, index: number): string {
  return `${runId}-stage-${index}`;
}

/**
 * Сносит демо-данные — и только их.
 *
 * Границей служит проект: всё удаляемое либо принадлежит демо-проекту, либо ссылается на его
 * запуски. Сам проект остаётся (его id и членство владельца переживают пересев), если явно не
 * попросили обратного — `seedDemoWorkspace({ reset: true })` пересоздаёт содержимое, а не проект.
 */
export async function removeDemoWorkspaceContent(options: { includeProject?: boolean } = {}): Promise<Record<string, number>> {
  const project = await AgentProject.findOne({ where: { slug: DEMO_PROJECT_SLUG } });
  if (!project) return {};
  const projectId = project.id;

  const runs = await AgentRun.findAll({ where: { projectId }, attributes: ['id'] });
  const runIds = runs.map((run) => run.id);
  const taskRows = await AgentTask.findAll({ where: { projectId }, attributes: ['id'] });
  const taskIds = taskRows.map((task) => task.id);

  const counts: Record<string, number> = {};
  const byRun = { runId: { [Op.in]: runIds } } as any;

  counts.interactions = runIds.length ? await AgentRunInteraction.destroy({ where: byRun }) : 0;
  counts.logs = runIds.length ? await AgentRunLog.destroy({ where: byRun }) : 0;
  counts.stages = runIds.length ? await AgentStageExecution.destroy({ where: byRun }) : 0;
  counts.jobs = runIds.length ? await AgentRunJob.destroy({ where: byRun }) : 0;
  counts.approvals = await AgentApprovalRequest.destroy({ where: { projectId } });
  counts.activities = await AgentActivity.destroy({ where: { projectId } });
  counts.comments = taskIds.length ? await AgentTaskComment.destroy({ where: { taskId: { [Op.in]: taskIds } } }) : 0;
  counts.runs = await AgentRun.destroy({ where: { projectId } });
  counts.tasks = await AgentTask.destroy({ where: { projectId } });
  counts.workflows = await AgentWorkflowSpec.destroy({ where: { id: WORKFLOW_ID } });
  counts.pipelineSpecs = await PipelineSpec.destroy({ where: { projectId } });
  counts.roles = await AgentRole.destroy({ where: { projectId } });
  if (options.includeProject) counts.projects = await AgentProject.destroy({ where: { id: projectId } });

  return counts;
}

/**
 * Собирает демо-проект целиком. Идемпотентна: повторный вызов приводит строки к тому же виду,
 * `reset: true` предварительно сносит содержимое (в том числе отвеченный вопрос и принятую заявку,
 * которые иначе так и останутся закрытыми).
 */
export async function seedDemoWorkspace(options: DemoSeedOptions): Promise<DemoSeedResult> {
  const now = options.now ?? new Date();
  const reset = options.reset === true;
  if (reset) await removeDemoWorkspaceContent();

  const existing = await AgentProject.findOne({ where: { slug: DEMO_PROJECT_SLUG } });
  const projectAttrs = {
    name: 'Демо-проект',
    slug: DEMO_PROJECT_SLUG,
    description:
      'Демонстрационный проект с подготовленными данными: задачи, запуски, лента и приёмка. ' +
      'Настоящий код здесь не собирается и никуда не выкатывается.',
    repoProvider: 'github' as const,
    repoConfig: { owner: 'agentiz-demo', repo: 'notes-app', defaultBranch: 'main' },
    trackerConfig: {},
    isActive: true,
    ownerId: options.ownerUserId,
  };
  const project = existing
    ? (await existing.update(projectAttrs), existing)
    : await AgentProject.create({ id: PROJECT_ID, ...projectAttrs, secrets: {} } as any);
  const projectId = project.id;

  const counts: Record<string, number> = {
    roles: 0, pipelineSpecs: 0, tasks: 0, runs: 0, stages: 0, logs: 0,
    comments: 0, activities: 0, interactions: 0, approvals: 0, workflows: 0,
  };

  for (const role of ROLES) {
    await ensure(AgentRole, role.id, {
      projectId,
      key: role.key,
      title: role.title,
      systemPrompt: role.systemPrompt,
      model: role.model,
      allowedTools: [...role.allowedTools],
      config: { executor: 'stub' },
    });
    counts.roles += 1;
  }

  await ensure(PipelineSpec, SPEC_DEFAULT_ID, {
    projectId, name: 'Основной пайплайн', matchTags: null, isDefault: true, isActive: true,
    version: 1, spec: DEFAULT_PIPELINE,
  });
  await ensure(PipelineSpec, SPEC_QA_ID, {
    projectId, name: 'Быстрая проверка (вердикт)', matchTags: ['qa'], isDefault: false, isActive: true,
    version: 1, spec: QA_PIPELINE,
  });
  counts.pipelineSpecs = 2;

  for (const task of TASKS) {
    await ensure(AgentTask, task.id, {
      projectId,
      externalId: task.externalId,
      externalUrl: null,
      title: task.title,
      description: task.description,
      tags: task.tags,
      status: task.status,
      priority: task.priority,
      pipelineSpecId: task.specId,
      sourceType: 'local',
      sourceName: 'Демо',
      createdAt: at(now, task.createdMinutes),
      updatedAt: at(now, task.updatedMinutes),
    });
    counts.tasks += 1;

    for (const run of task.runs) {
      await ensure(AgentRun, run.id, {
        taskId: task.id,
        projectId,
        status: run.status,
        trigger: 'manual',
        pipelineSnapshot: run.pipeline,
        pipelineSpecId: task.specId,
        currentStageIndex: run.stages.filter((stage) => stage.status !== 'pending').length - 1,
        startedAt: at(now, run.startedMinutes),
        finishedAt: run.finishedMinutes === null ? null : at(now, run.finishedMinutes),
        resultSummary: run.summary,
        errorMessage: run.error ?? null,
        branch: run.branch ?? null,
        commitSha: run.commitSha ?? null,
        verdict: run.verdict ?? null,
        verdictReason: run.verdictReason ?? null,
        usageInputTokens: run.usage?.input ?? null,
        usageOutputTokens: run.usage?.output ?? null,
        usageCacheReadTokens: run.usage?.cacheRead ?? null,
        usageCacheWriteTokens: run.usage?.cacheWrite ?? null,
        usageTotalTokens: run.usage ? run.usage.input + run.usage.output : null,
        usageEstimatedCostUsd: run.usage?.costUsd ?? null,
        createdAt: at(now, run.startedMinutes),
        updatedAt: at(now, run.finishedMinutes ?? run.startedMinutes),
      });
      counts.runs += 1;

      // Запись очереди нужна только как родитель вопроса агента (FK `AgentRunInteraction.jobId`).
      // Статус — `succeeded`: подметальщик смотрит на leased/running/released, и «живая» запись
      // осиротила бы вопрос через четверть часа.
      await ensure(AgentRunJob, `${run.id}-job`, {
        runId: run.id,
        projectId,
        jobKind: 'pipeline',
        status: 'succeeded',
        priority: 0,
        attempt: 1,
        snapshot: { demo: true },
        createdAt: at(now, run.startedMinutes),
        updatedAt: at(now, run.finishedMinutes ?? run.startedMinutes),
      });

      for (const stage of run.stages) {
        await ensure(AgentStageExecution, stageId(run.id, stage.index), {
          runId: run.id,
          stageIndex: stage.index,
          role: stage.role,
          agentRoleId: stage.roleId,
          status: stage.status,
          input: null,
          output: stage.summary ? { summary: stage.summary } : null,
          errorMessage: stage.error ?? null,
          startedAt: stage.status === 'pending' ? null : at(now, stage.startedMinutes),
          finishedAt: stage.finishedMinutes === null ? null : at(now, stage.finishedMinutes),
        });
        counts.stages += 1;
      }

      let logIndex = 0;
      for (const line of run.logs) {
        await ensure(AgentRunLog, `${run.id}-log-${logIndex}`, {
          runId: run.id,
          projectId,
          stageExecutionId: line.stage === undefined ? null : stageId(run.id, line.stage),
          level: line.level,
          message: line.message,
          meta: null,
          createdAt: at(now, line.minutes),
          updatedAt: at(now, line.minutes),
        });
        logIndex += 1;
        counts.logs += 1;
      }
    }

    for (const comment of task.comments) {
      await ensure(AgentTaskComment, comment.id, {
        taskId: task.id,
        authorKind: comment.authorKind,
        authorName: comment.authorName,
        authorId: comment.authorKind === 'human' ? options.ownerUserId : null,
        runId: comment.runId ?? null,
        body: comment.body,
        origin: 'local',
        createdAt: at(now, comment.minutes),
        updatedAt: at(now, comment.minutes),
      });
      counts.comments += 1;
    }
  }

  await ensure(AgentRunInteraction, INTERACTION.id, {
    projectId,
    runId: INTERACTION.runId,
    jobId: `${INTERACTION.runId}-job`,
    attempt: 1,
    stageExecutionId: stageId(INTERACTION.runId, INTERACTION.stageIndex),
    kind: 'elicitation',
    source: 'demo',
    externalRequestId: 'demo-elicitation-1',
    toolCallId: null,
    message: INTERACTION.message,
    requestedSchema: INTERACTION.requestedSchema,
    status: 'pending',
    responseAction: null,
    responseContent: null,
    answeredById: null,
    answeredByName: null,
    answeredAt: null,
    expiresAt: null,
    createdAt: at(now, INTERACTION.minutes),
    updatedAt: at(now, INTERACTION.minutes),
  });
  counts.interactions = 1;

  await ensure(AgentApprovalRequest, APPROVAL.id, {
    projectId,
    taskId: APPROVAL.taskId,
    // Воркфлоу за заявкой нет: решение ревьюера просто закрывает строку, продолжать нечего.
    workflowRunId: null,
    nodeId: null,
    runId: APPROVAL.runId,
    assigneeUserId: null,
    assigneeToken: 'agentiz-approval-decide',
    title: APPROVAL.title,
    message: APPROVAL.message,
    links: APPROVAL.links,
    status: 'pending',
    decidedByUserId: null,
    decidedAt: null,
    decisionComment: null,
    createdAt: at(now, APPROVAL.minutes),
    updatedAt: at(now, APPROVAL.minutes),
  });
  counts.approvals = 1;

  for (const activity of ACTIVITIES) {
    await ensure(AgentActivity, activity.id, {
      type: activity.type,
      kind: activity.kind,
      projectId,
      runId: activity.runId,
      taskId: activity.taskId,
      proposalId: null,
      interactionId: activity.interactionId ?? null,
      title: activity.title,
      body: activity.body,
      data: activity.data ?? null,
      createdAt: at(now, activity.minutes),
      updatedAt: at(now, activity.minutes),
    });
    counts.activities += 1;
  }

  const graph = demoWorkflowGraph(projectId);
  await ensure(AgentWorkflowSpec, WORKFLOW_ID, {
    name: graph.name,
    active: false,
    version: 1,
    spec: graph,
    projectId,
  });
  counts.workflows = 1;

  return {
    projectId,
    slug: DEMO_PROJECT_SLUG,
    ownerUserId: options.ownerUserId,
    reset,
    counts,
    waitingForPerson: { interactionId: INTERACTION.id, approvalId: APPROVAL.id },
    tasks: TASKS.map((task) => ({ id: task.id, title: task.title, status: task.status })),
  };
}
