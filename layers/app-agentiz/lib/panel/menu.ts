import { Op } from 'sequelize';
import { AgentProject } from '../../models/AgentProject';
import { AgentRun } from '../../models/AgentRun';
import { AgentTask } from '../../models/AgentTask';
import { can, projectIdsForUser, type AccessCache } from '../access/projectAccess';
import { hasGlobalToken, panelActor, requestAccessCache } from '../access/panelGuard';
import { GLOBAL_TOKENS, PROJECT_TOKENS } from '../access/tokens';
import { ACTIVE_RUN_STATUSES } from '../runBoard';
import { taskViewStatuses } from '../taskViews';
import { panelInboxCount } from './inboxPanel';
import { href, PROJECT_SETTINGS_TITLES, type RouteMatch } from './routeTree';

/**
 * The sidebar of an Agentiz screen, built on the server and handed to the page as a **page prop**.
 *
 * That is the whole mechanism, and it needs no change in adminizer: page props override shared
 * props (`allProps = {..._sharedProps, ...props}` in adminizer's `inertiaAdapter`), and
 * `menu`/`menuSections` are ordinary shared props that the sidebar component reads from
 * `usePage()`. Our render simply supplies its own.
 *
 * It is **not** `navbar.handleAdditionalLinks`: that hook is synchronous, never sees `req`, and is
 * evaluated in middleware registered before our routes — a context-dependent menu built there
 * lags one navigation behind, invisibly, and only on a machine with more than one project.
 */

/** The shape adminizer's `nav-main.tsx` renders. Icons are Material Icons names, not lucide. */
export interface AgentizMenuItem {
  id: string;
  title: string;
  link: string;
  icon: string;
  section: string;
  /** Rendered as `SidebarMenuBadge` since 5.1.0-build.28; `0` and `undefined` draw nothing. */
  badge?: number;
  /** No sub-items anywhere in our tree: a second level would hide the thing it groups. */
  actions: never[];
  accessRightsToken: string | null;
  type: 'self';
}

/**
 * Section headers. `order` is explicit for all of ours so they never interleave with what other
 * apps contribute — the panel's default ordering is alphabetical, and «Автоматизация» sorting
 * between «Админ» and «Моя работа» reads as noise.
 */
export const AGENTIZ_SECTIONS = {
  'Моя работа': { icon: 'inbox', order: 10 },
  Проект: { icon: 'dashboard', order: 10 },
  Проекты: { icon: 'workspaces', order: 20 },
  Автоматизация: { icon: 'account_tree', order: 20 },
  Код: { icon: 'folder_copy', order: 30 },
  Инфраструктура: { icon: 'dns', order: 30 },
  Интеграции: { icon: 'power', order: 40 },
  Настройки: { icon: 'settings', order: 50 },
  // `storage`, не `database`: панель рисует иконку лигатурой шрифта Material Icons Outlined, а
  // такого имени в нём нет — вместо значка печаталось слово «database» и сдвигало строку.
  Админ: { icon: 'storage', order: 90 },
} satisfies Record<string, { icon: string; order: number }>;

/**
 * The name of a section, as a type. `render.ts` prints these words as the first breadcrumb, so a
 * section renamed here and not there would have the crumb and the sidebar group disagree — with
 * `satisfies` above, the keys stay literal and the compiler catches it.
 */
export type AgentizSection = keyof typeof AGENTIZ_SECTIONS;

function item(
  id: string,
  title: string,
  link: string,
  icon: string,
  section: string,
  badge?: number,
): AgentizMenuItem {
  return { id, title, link, icon, section, badge, actions: [], accessRightsToken: null, type: 'self' };
}

/** The project the sidebar is currently "inside", or null in the global mode. */
async function projectOfRoute(match: RouteMatch | null, actor: any, cache: AccessCache) {
  const slug = match?.params.slug;
  if (!slug) return null;
  const project = await AgentProject.findOne({ where: { slug } });
  if (!project) return null;
  return (await can(actor, project.id, PROJECT_TOKENS.read, cache)) ? project : null;
}

/**
 * The rest of the panel — Documentation, Users, Groups, whatever another app registered. Without
 * it a person who opened Agentiz has no way back to the users or the knowledge base, because our
 * `menu` replaced the panel's own wholesale.
 *
 * Built from the **public** `adminizer.menuHelper`, not from the `InertiaMenuHelper` the panel uses
 * for itself: that class and the `listAccessibleMenuItems` behind it sit at subpaths the package
 * does not export (`ERR_PACKAGE_PATH_NOT_EXPORTED`, verified, same trap as `adminizer/ui/*`). So
 * the raw items come from the helper and the two things it leaves to the caller are done here:
 * the access filter and the translation.
 *
 * The filter is `checkAnyPermission` — never `hasPermission`/`enoughPermissions`, which are frozen
 * synchronous and deny a contextual token in silence (see AGENTS.md).
 */
async function restOfPanel(req: any): Promise<AgentizMenuItem[]> {
  const adminizer = req?.adminizer ?? req?.runtime;
  const helper = adminizer?.menuHelper;
  if (!helper || typeof helper.getMenuItems !== 'function' || !req.user) return [];

  const translate = (text: string) => (typeof req.i18n?.__ === 'function' ? req.i18n.__(text) : text);

  try {
    const raw: any[] = helper.getMenuItems(req.user) ?? [];
    const allowed = await Promise.all(raw.map(async (entry) => {
      // Ours are replaced by the tree above; the raw CRUD of our own models is reachable through
      // «Админ → Модели данных» instead of one sidebar section per model.
      if (entry?.section === 'Agentiz') return null;
      const token = entry?.accessRightsToken;
      if (token && adminizer.accessRightsHelper) {
        const ok = await adminizer.accessRightsHelper.checkAnyPermission([token], req.user);
        if (!ok) return null;
      }
      return {
        ...entry,
        title: translate(entry.title),
        section: entry.section ? translate(entry.section) : 'Platform',
        actions: entry.actions ?? [],
        // `badge` may be a resolver, which cannot travel to the browser as JSON. Resolving it here
        // would mean a query per item on every Agentiz page; a number that is simply absent is the
        // pre-existing behaviour for these items anyway.
        badge: typeof entry.badge === 'function' ? undefined : entry.badge,
      } as AgentizMenuItem;
    }));
    return allowed.filter(Boolean) as AgentizMenuItem[];
  } catch {
    // A menu that cannot be built must not take the page down with it.
    return [];
  }
}

/**
 * How many rows of the inbox actually hold something — the number the screen prints in its own
 * header, from the same `lib/inbox/` the phone reads. `0` draws nothing, which is what the badge
 * should do when there is nothing waiting.
 *
 * It costs the queries of a whole inbox on every Agentiz page, so a failure must not take the menu
 * with it: a sidebar without a number is a smaller loss than a page that will not render.
 */
async function blockingInboxCount(req: any): Promise<number | undefined> {
  try {
    return (await panelInboxCount(req)) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Два числа проектного сайдбара: открытые задачи и идущие запуски — те же, что печатают сами
 * экраны за этими пунктами.
 *
 * Определения не свои: «открытая» — вкладка «Открытые» доски задач (`taskViewStatuses('open')`),
 * «идёт» — верхняя половина доски запусков (`ACTIVE_RUN_STATUSES` из `lib/runBoard.ts`). Считаются
 * двумя `COUNT`, а не чтением досок: бейджу нужно число, а не строки. Как и у входящих, отказ здесь
 * стоит бейджа, но не страницы.
 */
async function projectBadges(projectId: string): Promise<{ tasks?: number; runs?: number }> {
  try {
    const openStatuses = taskViewStatuses('open') ?? [];
    const [tasks, runs] = await Promise.all([
      openStatuses.length > 0
        ? AgentTask.count({ where: { projectId, status: { [Op.in]: openStatuses } } })
        : Promise.resolve(0),
      AgentRun.count({ where: { projectId, status: { [Op.in]: ACTIVE_RUN_STATUSES } } }),
    ]);
    return { tasks: tasks || undefined, runs: runs || undefined };
  } catch {
    return {};
  }
}

export async function buildAgentizMenu(req: any, match: RouteMatch | null): Promise<AgentizMenuItem[]> {
  const actor = panelActor(req);
  const cache = requestAccessCache(req);
  const project = await projectOfRoute(match, actor, cache);

  const items: AgentizMenuItem[] = [];

  if (project) {
    const slug = project.slug;
    const p = { slug };
    const badges = await projectBadges(project.id);
    items.push(
      item('agentiz-project-overview', 'Обзор', href('project.overview', p), 'dashboard', 'Проект'),
      item('agentiz-project-tasks', 'Задачи', href('project.tasks', p), 'checklist', 'Проект', badges.tasks),
      item('agentiz-project-runs', 'Запуски', href('project.runs', p), 'play_circle', 'Проект', badges.runs),
    );

    if (await can(actor, project.id, PROJECT_TOKENS.projectConfigure, cache)) {
      items.push(
        item('agentiz-project-pipelines', 'Пайплайны', href('project.pipelines', p), 'account_tree', 'Автоматизация'),
        item('agentiz-project-workflows', 'Воркфлоу', href('project.workflows', p), 'schema', 'Автоматизация'),
        item('agentiz-project-repos', 'Репозитории', href('project.repositories', p), 'folder_copy', 'Код'),
      );
    }

    // Названия секций — из `routeTree.ts`: те же слова печатают крошка и заголовок экрана.
    if (await can(actor, project.id, PROJECT_TOKENS.projectMembers, cache)) {
      items.push(item('agentiz-project-members', PROJECT_SETTINGS_TITLES.members, href('project.settings', { ...p, section: 'members' }), 'group', 'Настройки'));
    }
    if (await can(actor, project.id, PROJECT_TOKENS.projectConfigure, cache)) {
      items.push(
        item('agentiz-project-sources', PROJECT_SETTINGS_TITLES.sources, href('project.settings', { ...p, section: 'sources' }), 'power', 'Настройки'),
        item('agentiz-project-notifications', PROJECT_SETTINGS_TITLES.notifications, href('project.settings', { ...p, section: 'notifications' }), 'notifications', 'Настройки'),
        item('agentiz-project-general', PROJECT_SETTINGS_TITLES.general, href('project.settings', { ...p, section: 'general' }), 'settings', 'Настройки'),
      );
    }
  } else {
    items.push(
      item('agentiz-overview', 'Обзор', href('overview'), 'dashboard', 'Моя работа'),
      item('agentiz-inbox', 'Входящие', href('inbox'), 'inbox', 'Моя работа', await blockingInboxCount(req)),
      item('agentiz-runs', 'Запуски', href('runs'), 'play_circle', 'Моя работа'),
    );

    const projectCount = (await projectIdsForUser(actor, PROJECT_TOKENS.read, cache)).length;
    items.push(item('agentiz-projects', 'Проекты', href('projects'), 'workspaces', 'Проекты', projectCount || undefined));

    if (hasGlobalToken(req, GLOBAL_TOKENS.workersManage)) {
      items.push(
        item('agentiz-workers', 'Воркеры', href('workers'), 'dns', 'Инфраструктура'),
        item('agentiz-harnesses', 'Обвязки и лимиты', href('harnesses'), 'speed', 'Инфраструктура'),
      );
    }
    if (hasGlobalToken(req, GLOBAL_TOKENS.connectionsManage)) {
      items.push(item('agentiz-git', 'Git-провайдеры', href('integrations.git'), 'folder_copy', 'Интеграции'));
    }
    if (hasGlobalToken(req, GLOBAL_TOKENS.notificationsManage)) {
      items.push(item('agentiz-notifications', 'Уведомления', href('settings.notifications'), 'notifications', 'Настройки'));
    }
    items.push(item('agentiz-data', 'Модели данных', href('admin.data'), 'storage', 'Админ'));
  }

  return [...items, ...(await restOfPanel(req))];
}

/**
 * Section headers for the page prop. Ours plus the panel's own, so the items appended by
 * `restOfPanel` keep their icons and ordering — the sidebar looks up a section by its *translated*
 * name, which is why the panel's keys are translated here the same way its own helper does it.
 */
export function buildAgentizSections(req: any): Record<string, { icon?: string; order?: number }> {
  const helper = (req?.adminizer ?? req?.runtime)?.menuHelper;
  const translate = (text: string) => (typeof req?.i18n?.__ === 'function' ? req.i18n.__(text) : text);
  let panelSections: Record<string, any> = {};
  try {
    panelSections = Object.fromEntries(
      Object.entries(helper?.getSections?.() ?? {}).map(([name, section]) => [translate(name), section]),
    );
  } catch {
    panelSections = {};
  }
  // Ours win on a name collision: the order values above are chosen against each other.
  return { ...panelSections, ...AGENTIZ_SECTIONS };
}

/**
 * Переключатель проекта в левом верхнем углу — тот самый, который в макете стоит вместо бренда.
 *
 * Оказалось, что менять adminizer для этого не нужно: он уже рисует там **выпадающее меню**, а
 * заполняют его два обычных расшаренных пропа — `brand` (подпись на кнопке) и `section` (список
 * пунктов, `app-sidebar.tsx`). Пропы страницы перебивают расшаренные, поэтому наш рендер просто
 * присылает свои — ровно тем же механизмом, что и `menu`, `menuSections`, `breadcrumbs`.
 *
 * Чего этим способом **не** добиться и что остаётся просьбой A3: вторая строка на кнопке
 * (`brand` — это строка, а не разметка) и своя иконка вместо жёстко зашитой `rocket_launch`.
 *
 * Стоит не только под `/agentiz`: `panelShell.ts` кладёт то же самое в расшаренные пропы каждой
 * страницы панели, поэтому `match` здесь бывает `null` и означает глобальный режим.
 *
 * Список специально не бесконечный: `SWITCHER_LIMIT` проектов, дальше — «Все проекты». Выпадашка,
 * в которой нужно скроллить, перестаёт быть переключателем.
 */
const SWITCHER_LIMIT = 10;

export interface AgentizBrandSection {
  id: string;
  title: string;
  link: string;
  icon: string;
  type?: 'self' | 'blank';
}

export async function buildAgentizBrand(req: any, match: RouteMatch | null): Promise<{
  brand: string;
  section: AgentizBrandSection[];
}> {
  const actor = panelActor(req);
  const cache = requestAccessCache(req);
  const current = await projectOfRoute(match, actor, cache);

  let projects: AgentProject[] = [];
  try {
    const ids = await projectIdsForUser(actor, PROJECT_TOKENS.read, cache);
    projects = ids.length > 0
      ? await AgentProject.findAll({ where: { id: ids }, order: [['name', 'ASC']], limit: SWITCHER_LIMIT })
      : [];
  } catch {
    // Переключатель — удобство. Его отсутствие не повод не отдать страницу.
    projects = [];
  }

  const section: AgentizBrandSection[] = projects.map((project) => ({
    id: `agentiz-switch-${project.slug}`,
    title: project.name,
    link: href('project.overview', { slug: project.slug }),
    // Значок говорит состояние проекта, как точка в макете: открытый — текущий, серый — выключенный.
    icon: project.id === current?.id ? 'radio_button_checked'
      : project.isActive === false ? 'radio_button_unchecked'
        : 'circle',
  }));

  section.push(
    { id: 'agentiz-switch-all', title: 'Все проекты', link: href('projects'), icon: 'workspaces' },
    { id: 'agentiz-switch-global', title: 'Обзор без проекта', link: href('overview'), icon: 'dashboard' },
    // Двери «в панель администратора» здесь нет намеренно: корень панели — это и есть обзор
    // (`panelShell.ts`), а страницы самой панели — пользователи, группы, база знаний — стоят
    // в этом же сайдбаре снизу (`restOfPanel`). Второго контекста, куда вела бы дверь, больше нет.
  );

  return { brand: current?.name ?? 'Agentiz', section };
}
