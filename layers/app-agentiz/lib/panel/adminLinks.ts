import { GLOBAL_TOKENS } from '../access/tokens';
import { href, PROJECT_SETTINGS_TITLES, routeBase, ROOT_ROUTES, type RootRouteName } from './routeTree';

/**
 * Экраны Agentiz в реестре навигации adminizer — то, из чего состоит палитра Ctrl/Cmd+K.
 *
 * Панель ищет не по страницам, а по **реестру**: `GET {routePrefix}/api/links/search` отвечает из
 * `AdminLinkHandler.search()`, а тот обходит `listAccessibleMenuItems` — пункты `navbar` из конфига
 * плюс ссылки, зарегистрированные приложениями. Наш сайдбар в этот реестр не попадает вовсе: он
 * **проп страницы** (`lib/panel/menu.ts`), который живёт только на наших адресах. Измерено до
 * правки: на запрос «воркер», «Обзор», «задач» поиск отвечал пустотой, а на пустой запрос выдавал
 * ровно одну нашу строку — дверь «Agentiz» из `config/adminizer.ts`.
 *
 * Отсюда два правила этого файла:
 *
 * * **адреса берутся из `href()`**, а не пишутся руками: реестр — четвёртое место после сайдбара,
 *   крошек и модуля, которое называет те же экраны, и расхождение здесь выглядело бы как «поиск
 *   ведёт не туда»;
 * * **видимость — тот же токен, что и в сайдбаре**: `AdminLinkHandler` фильтрует список через
 *   `checkPermission`, поэтому человек не найдёт в палитре экран, которого не видит в меню.
 *
 * Секция `Agentiz` тоже не украшение: `restOfPanel()` в `menu.ts` выбрасывает эту секцию, когда
 * дописывает остаток панели к нашему меню, — значит на наших страницах эти строки не появятся, а
 * на чужих дадут прямую дверь внутрь вместо одной общей.
 */

/** Форма `AdminLink` adminizer: `id` он считает сам из `type` + `name`. */
export interface AgentizAdminLink {
  type: 'agentiz';
  name: string;
  link: string;
  title: string;
  section: 'Agentiz';
  accessRightsToken?: string;
}

/** Форма `AdminLinkTemplate`: адрес с `:параметром`, который заполняет вызывающий. */
export interface AgentizAdminLinkTemplate {
  id: string;
  title: string;
  template: string;
  description: string;
  section: 'Agentiz';
}

/**
 * Что показывать в палитре и под каким токеном. `overview` здесь нет намеренно: его адрес уже
 * зарегистрирован строкой `agentiz-home` в `config/adminizer.ts`, и вторая строка на тот же адрес
 * читалась бы как два разных экрана.
 */
const SCREENS: Array<{ route: Exclude<RootRouteName, 'overview'>; title: string; token?: string }> = [
  { route: 'inbox', title: 'Входящие' },
  { route: 'runs', title: 'Запуски' },
  { route: 'projects', title: 'Проекты' },
  { route: 'workers', title: 'Воркеры', token: GLOBAL_TOKENS.workersManage },
  { route: 'harnesses', title: 'Обвязки и лимиты', token: GLOBAL_TOKENS.workersManage },
  { route: 'integrations.git', title: 'Git-провайдеры', token: GLOBAL_TOKENS.connectionsManage },
  { route: 'settings.notifications', title: 'Уведомления', token: GLOBAL_TOKENS.notificationsManage },
  { route: 'admin.data', title: 'Модели данных' },
];

export function agentizAdminLinks(): AgentizAdminLink[] {
  return SCREENS.map((screen) => ({
    type: 'agentiz' as const,
    // `name` уходит в идентификатор (`agentiz:<name>`), поэтому это имя маршрута, а не заголовок:
    // заголовок переводится и может совпасть у двух приложений, имя маршрута — нет.
    name: screen.route,
    link: href(screen.route),
    title: screen.title,
    section: 'Agentiz' as const,
    ...(screen.token ? { accessRightsToken: screen.token } : {}),
  }));
}

/**
 * Адреса с параметром: в палитру Ctrl+K они не попадают (она показывает только готовые ссылки), но
 * их видит ассистент — `listTemplates` и `resolveTemplate`. Без них «открой задачу 5629c142» ему
 * некуда вести: адрес задачи знает только `routeTree`.
 *
 * Токена здесь нет специально: доступ к проекту решает не глобальный токен, а членство
 * (`lib/access/projectAccess.ts`), и проверяет его сам экран при открытии.
 */
export function agentizAdminLinkTemplates(): AgentizAdminLinkTemplate[] {
  const base = routeBase();
  return [
    {
      id: 'agentiz-project',
      title: 'Agentiz: проект',
      template: `${base}/projects/:slug`,
      description: 'Обзор проекта Agentiz по его слагу.',
      section: 'Agentiz',
    },
    {
      id: 'agentiz-task',
      title: 'Agentiz: задача',
      template: `${base}/projects/:slug/tasks/:taskId`,
      description: 'Карточка задачи: обсуждение, запуски, файлы.',
      section: 'Agentiz',
    },
    {
      id: 'agentiz-run',
      title: 'Agentiz: запуск',
      template: `${base}/projects/:slug/runs/:runId`,
      description: 'Запуск: этапы, лог, изменения, ревью.',
      section: 'Agentiz',
    },
    {
      id: 'agentiz-pipeline',
      title: 'Agentiz: пайплайн',
      template: `${base}/projects/:slug/pipelines/:specId`,
      description: 'Редактор спеки пайплайна.',
      section: 'Agentiz',
    },
    {
      id: 'agentiz-project-settings',
      title: 'Agentiz: настройки проекта',
      template: `${base}/projects/:slug/settings/:section`,
      description: `Разделы: ${Object.keys(PROJECT_SETTINGS_TITLES).join(', ')}.`,
      section: 'Agentiz',
    },
    {
      id: 'agentiz-worker',
      title: 'Agentiz: воркер',
      template: `${base}/workers/:workerId`,
      description: 'Машина: доступ, исполнители, папки, git, обвязки.',
      section: 'Agentiz',
    },
  ];
}

/** Проверка на опечатку: каждый экран из списка обязан быть корневым маршрутом дерева. */
export function assertScreensAreRootRoutes(): void {
  for (const screen of SCREENS) {
    if (!ROOT_ROUTES.includes(screen.route)) {
      throw new Error(`Agentiz admin link "${screen.route}" is not a parameterless route`);
    }
  }
}
