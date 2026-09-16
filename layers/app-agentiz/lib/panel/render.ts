import { AgentProject } from '../../models/AgentProject';
import { AgentRun } from '../../models/AgentRun';
import { AgentTask } from '../../models/AgentTask';
import { AgentWorkflowSpec } from '../../models/AgentWorkflowSpec';
import { AgentTaskService, TASK_PRIORITIES, TASK_STATUSES } from '../../services/AgentTaskService';
import { AGENTIZ_WORKFLOW_PROVIDER_ID } from '../workflow/specProvider';
import { DEFAULT_TASK_VIEW, taskViewStatuses } from '../taskViews';
import { can, projectIdsForUser } from '../access/projectAccess';
import { hasGlobalToken, panelActor, requestAccessCache } from '../access/panelGuard';
import { GLOBAL_TOKENS, PROJECT_TOKENS } from '../access/tokens';
import { adminizerModuleStylesheet, adminizerModuleUrl } from '../adminizerModuleUrl';
import { buildAgentizBrand, buildAgentizMenu, buildAgentizSections, type AgentizSection } from './menu';
import { listRuns } from '../runBoard';
import { workerFleet } from '../workerBoard';
import { panelInbox } from './inboxPanel';
import { gitProviderDetail, gitProvidersOverview, projectRepositoryRows } from './repositoriesPanel';
import { pipelineBoard } from './pipelinesPanel';
import { globalOverview, projectOverview, projectRows } from './overviewPanel';
import { projectAgentRoles, projectGeneralView, projectMembersView, projectSourcesView } from './settingsPanel';
import { NotificationPolicyService } from '../../services/NotificationPolicyService';
import { agentizDataModels } from './modelConfigs';
import {
  configureRouteTree,
  href,
  matchRoute,
  PROJECT_SETTINGS_SECTIONS,
  PROJECT_SETTINGS_TITLES,
  type ProjectSettingsSection,
  type RouteMatch,
} from './routeTree';

/**
 * Renders any address under `/agentiz`. One registered route serves the whole tree because the
 * app-adminizer dispatcher matches a prefix — so the path is parsed here, not by express.
 */

/** Where the tree is mounted for this request, e.g. `/dashboard/agentiz`. */
function baseOf(req: any): string {
  const prefix = req?.adminizer?.config?.routePrefix ?? req?.runtime?.config?.routePrefix ?? '/dashboard';
  return `${prefix}/agentiz`;
}

/** The part of the path the route tree actually matches against. */
function subPathOf(req: any, base: string): string {
  const path = String(req.path ?? req.url ?? '');
  return path.startsWith(base) ? path.slice(base.length) || '/' : '/';
}

/**
 * Crumbs the panel header draws, sent as the `breadcrumbs` page prop (adminizer ≥ 5.1.0-build.28).
 *
 * A `switch`, not a lookup table: `href` throws on a missing parameter by design, and a table
 * would build every route's crumbs — including the project ones — on a global address. It did
 * exactly that once and took the process down with it, so the shape here is deliberate.
 *
 * `entity` is the name of the thing the address opens, when the screen's own data already carries
 * one and it reads better than the id. Optional rather than looked up here: this function must not
 * grow a query per crumb, and an id is always a correct answer.
 *
 * The **first** crumb is the sidebar section the screen lives in, not a constant «Agentiz»: that
 * is what the `ui-1-sol` mock does, and it is the only thing in the header that says which of the
 * six groups of the sidebar you are inside. Words come from `AGENTIZ_SECTIONS` in `menu.ts`, so
 * the crumb and the group it names cannot be renamed apart; a section crumb carries no `href`,
 * because a section is not an address. Inside a project the chain starts at «Проекты» instead —
 * there the project itself is the context, and the global overview is one click away in the
 * sidebar.
 */
function crumbsFor(match: RouteMatch, projectName: string | null, entity?: string | null): Array<{ title: string; href?: string }> {
  const root = { title: 'Agentiz', href: href('overview') };
  const p = match.params;
  const slug = p.slug;
  const project = () => ({ title: projectName ?? slug, href: href('project.overview', { slug }) });
  const projects = () => ({ title: 'Проекты', href: href('projects') });
  /** A sidebar group as a crumb. The argument is a key of `AGENTIZ_SECTIONS`, checked below. */
  const section = (name: AgentizSection) => ({ title: name });
  /** The project chain every project screen starts with: «Проекты › <проект>». */
  const inProject = () => [projects(), project()];

  switch (match.name) {
    case 'overview': return [root, { title: 'Обзор' }];
    case 'inbox': return [root, { title: 'Входящие' }];
    case 'runs': return [root, { title: 'Запуски' }];
    case 'projects': return [root, { title: 'Проекты' }];
    case 'project.overview': return [projects(), { title: projectName ?? slug }, { title: 'Обзор' }];
    case 'project.tasks': return [...inProject(), { title: 'Задачи' }];
    // Same reason as the run below: the id is a uuid, and the crumb bar is not where anybody copies
    // one — the head is enough to recognise what you are on, and the whole string wraps.
    case 'project.task': return [...inProject(), { title: 'Задачи', href: href('project.tasks', { slug }) }, { title: p.taskId.slice(0, 8) }];
    case 'project.runs': return [...inProject(), { title: 'Запуски' }];
    // A run is a uuid and the crumb bar is not where anybody copies one: the head is enough to
    // recognise the run you are on, and the whole string wraps onto three lines.
    case 'project.run': return [...inProject(), { title: 'Запуски', href: href('project.runs', { slug }) }, { title: p.runId.slice(0, 8) }];
    case 'project.pipelines': return [...inProject(), section('Автоматизация'), { title: 'Пайплайны' }];
    case 'project.pipeline': return [...inProject(), { title: 'Пайплайны', href: href('project.pipelines', { slug }) }, { title: entity ?? p.specId }];
    case 'project.workflows': return [...inProject(), section('Автоматизация'), { title: 'Воркфлоу' }];
    case 'project.workflow': return [...inProject(), { title: 'Воркфлоу', href: href('project.workflows', { slug }) }, { title: entity ?? p.workflowId.slice(0, 8) }];
    case 'project.repositories': return [...inProject(), { title: 'Репозитории' }];
    case 'project.settings': return [...inProject(), section('Настройки'), { title: PROJECT_SETTINGS_TITLES[p.section as ProjectSettingsSection] ?? p.section }];
    case 'workers': return [section('Инфраструктура'), { title: 'Воркеры' }];
    // The machine's name, not its uuid: the whole id wrapped the crumb bar onto two lines and is
    // not what anybody recognises a worker by.
    case 'worker': return [section('Инфраструктура'), { title: 'Воркеры', href: href('workers') }, { title: entity ?? p.workerId.slice(0, 8) }];
    case 'harnesses': return [section('Инфраструктура'), { title: 'Обвязки и лимиты' }];
    case 'integrations.git': return [section('Интеграции'), { title: 'Git-провайдеры' }];
    case 'integrations.gitProvider': return [section('Интеграции'), { title: 'Git-провайдеры', href: href('integrations.git') }, { title: p.provider }];
    case 'settings.notifications': return [section('Настройки'), { title: 'Уведомления' }];
    case 'admin.data': return [section('Админ'), { title: 'Модели данных' }];
    default: return [root];
  }
}

/**
 * The name of the entity the address opens, for the last crumb. Read from the data the screen was
 * given anyway — never a query of its own, and `null` is always a legal answer (the crumb then
 * prints the head of the id).
 */
function entityNameOf(match: RouteMatch, data: Record<string, unknown>): string | null {
  if (match.name === 'project.pipeline') return (data as any)?.board?.spec?.name ?? null;
  if (match.name === 'worker') {
    const workers = (data as any)?.fleet?.workers as Array<{ id: string; name: string }> | undefined;
    return workers?.find((worker) => worker.id === match.params.workerId)?.name ?? null;
  }
  return null;
}

/**
 * Data the screen needs, resolved on the server and sent as props — no round trip before the first
 * paint. Only the screens already ported are here; every other one still fetches through its own
 * `_method` endpoint until it is. What a screen keeps fetching afterwards (a log tail, a poll) is
 * deliberately *not* moved here: this is the first paint, not the whole conversation.
 */
async function dataFor(req: any, match: RouteMatch, project: AgentProject | null): Promise<Record<string, unknown>> {
  const actor = panelActor(req);
  const cache = requestAccessCache(req);

  if (match.name === 'projects') {
    const ids = await projectIdsForUser(actor, PROJECT_TOKENS.read, cache);
    const projects = await AgentProject.findAll({ where: { id: ids }, order: [['createdAt', 'DESC']] });
    // The counters beside a name come from the same readers the screens behind them use
    // (`overviewPanel.projectRows`), not from a count written for this list.
    return { projects: await projectRows(projects) };
  }

  // Both overviews are built from other screens' own readers (`overviewPanel.ts`) — the inbox, the
  // run board and the activity feed — so a number here can never disagree with the screen it links
  // to. Server-rendered and not polled: every block that moves is one click from a screen that is.
  if (match.name === 'overview') return { overview: await globalOverview(req) };
  if (match.name === 'project.overview' && project) return { overview: await projectOverview(req, project) };

  if (match.name === 'runs' || match.name === 'project.runs') {
    // The same function the `_method=listRuns` endpoint answers with, so the first paint and every
    // poll after it are one shape. The status filter is read from the query here too: it lives in
    // the address, and a first render that ignored it would show the unfiltered list for one tick.
    const status = typeof req.query?.status === 'string' ? req.query.status : '';
    return {
      runs: project
        ? await listRuns(project.id, undefined, status || undefined)
        : await listRuns('', await projectIdsForUser(actor, PROJECT_TOKENS.read, cache), status || undefined),
      status,
    };
  }

  if (match.name === 'project.run') {
    // Only whether the run exists *in this project* — not the run itself. A run's payload carries
    // the patch, which can be megabytes, and Inertia props travel inside the HTML; the screen asks
    // for it over `getRunDetails` like the old one did. The check is what stops
    // `/projects/other/runs/<id>` from drawing one project's run under another's sidebar.
    const run = project
      ? await AgentRun.findByPk(match.params.runId, { attributes: ['id', 'projectId'] })
      : null;
    return { runId: match.params.runId, found: Boolean(run && run.projectId === project!.id) };
  }

  if (match.name === 'project.tasks' && project) {
    // The same call the `_method=getTasks` endpoint answers with, so the first paint and every
    // reload after it are one shape. The tab and the priority are read from the address for the
    // reason the run board reads its status there: a first render that ignored them would show the
    // unfiltered board for one tick and then jump.
    const view = typeof req.query?.view === 'string' ? req.query.view : '';
    const priority = typeof req.query?.priority === 'string' ? req.query.priority : '';
    const search = typeof req.query?.search === 'string' ? req.query.search : '';
    const tasks = await AgentTaskService.list({
      projectId: project.id,
      statuses: taskViewStatuses(view || DEFAULT_TASK_VIEW),
      priority: priority || undefined,
      search: search || undefined,
    });
    return {
      tasks: { items: tasks.items, total: tasks.total, statusCounts: tasks.statusCounts },
      view: view || DEFAULT_TASK_VIEW,
      priority,
      search,
      // Which statuses and priorities exist at all — the edit form's selects. Not the whole
      // `filterOptions` payload: its project list belongs to a board that spans projects, and this
      // one never leaves the project in the address.
      filters: { statuses: TASK_STATUSES, priorities: TASK_PRIORITIES },
    };
  }

  if (match.name === 'project.task') {
    // Only whether the task exists *in this project*, like a run: the details payload carries the
    // whole comment thread and the tail of the last run's log, and Inertia props travel inside the
    // HTML. The screen asks for it over `getTask`, which is also what it re-reads after every
    // write. The check is what stops `/projects/other/tasks/<id>` from drawing one project's task
    // under another's sidebar.
    const task = project
      ? await AgentTask.findByPk(match.params.taskId, { attributes: ['id', 'projectId'] })
      : null;
    return {
      taskId: match.params.taskId,
      found: Boolean(task && task.projectId === project!.id),
      filters: { statuses: TASK_STATUSES, priorities: TASK_PRIORITIES },
    };
  }

  if (match.name === 'inbox') {
    // Server-rendered, like the project list: the inbox is the first screen a person opens, and a
    // spinner where "что меня ждёт" should be is the one place a round trip is most felt.
    return { inbox: await panelInbox(req) };
  }

  if (match.name === 'workers' || match.name === 'worker' || match.name === 'harnesses') {
    // One answer for all three fleet screens: they read the same two lists (machines and the
    // subscriptions behind them) from opposite ends, and the old screen needed four round trips
    // before it could draw anything. Polling afterwards still goes through `getWorkers` /
    // `getCapacity`, which answer with the same shapes.
    return { fleet: await workerFleet(req) };
  }

  if (match.name === 'project.repositories' && project) {
    // Two different boundaries meet on this screen and the screen has to know both. *Which rows* is
    // the project's own read right, already settled by `resolveProject`. *Which buttons* is
    // `projectConfigure` — a project reader sees what the project works with and edits nothing. And
    // the catalogue a new link is picked from is installation-wide (`agentiz-connections-manage`),
    // which is why «Добавить репозиторий» is a third answer and not the second one: the mirrored
    // repositories of every account are not a project's property.
    return {
      repositories: await projectRepositoryRows([project.id]),
      canConfigure: await can(actor, project.id, PROJECT_TOKENS.projectConfigure, cache),
      canManageConnections: hasGlobalToken(req, GLOBAL_TOKENS.connectionsManage),
    };
  }

  if ((match.name === 'project.pipelines' || match.name === 'project.pipeline') && project) {
    // One answer for both screens, like the fleet: the row of a pipeline and the form inside it
    // read the same worker and repository names, and the list already has to say what a pipeline
    // works on. Only the opened spec carries its document — see `pipelinesPanel.ts`.
    return {
      board: await pipelineBoard(project.id, {
        canConfigure: await can(actor, project.id, PROJECT_TOKENS.projectConfigure, cache),
        specId: match.name === 'project.pipeline' ? match.params.specId : undefined,
      }),
    };
  }

  if (match.name === 'integrations.git' || match.name === 'integrations.gitProvider') {
    // Installation-wide, so the gate is a global token rather than a project one — and it is the
    // same `hasGlobalToken` the sidebar used to decide whether to draw the row at all, so a person
    // who cannot see the item cannot reach the address either.
    if (!hasGlobalToken(req, GLOBAL_TOKENS.connectionsManage)) return { denied: true };
    return match.name === 'integrations.git'
      ? { providers: await gitProvidersOverview() }
      : { provider: await gitProviderDetail(match.params.provider) };
  }

  if (match.name === 'project.settings' && project) {
    // Which section is in the address; anything unknown falls back to the first one rather than
    // rendering an empty page — the address is also what the sidebar's four rows link to.
    const wanted = match.params.section as ProjectSettingsSection;
    const section: ProjectSettingsSection = PROJECT_SETTINGS_SECTIONS.includes(wanted) ? wanted : 'members';
    // Seeing what a project is configured with is project **read** — already settled by
    // `resolveProject`. Changing it is `project-configure`, except for the members list, whose
    // writer is `project-members`; that one travels inside `members.meta.canManage`, from the same
    // builder `memberRoutes` answers with.
    const canConfigure = await can(actor, project.id, PROJECT_TOKENS.projectConfigure, cache);
    const settings: Record<string, unknown> = { section, canConfigure };

    if (section === 'members') {
      settings.members = await projectMembersView(project.id, actor, cache);
      // Read-only, and here on purpose: «роль» means two things in one project, and this is the
      // screen where the two collide. Editing them stays with the pipelines.
      settings.agentRoles = await projectAgentRoles(project.id);
    } else if (section === 'sources') {
      const sources = await projectSourcesView(project.id);
      settings.sources = sources.sources;
      settings.managers = sources.managers;
    } else if (section === 'notifications') {
      settings.policy = await NotificationPolicyService.describeScope({ scope: 'project', id: project.id });
    } else {
      settings.general = await projectGeneralView(project);
    }
    return { settings };
  }

  if (match.name === 'settings.notifications') {
    // The `defaults` scope belongs to nobody's project, so writing it is the global
    // `agentiz-notifications-manage` — the same token the sidebar row is drawn by. Reading is
    // deliberately looser (as in `notificationRoutes`): the resolved values explain why something
    // did or did not arrive, and hiding them would only make that harder.
    const [policy, overrides] = await Promise.all([
      NotificationPolicyService.describeScope({ scope: 'defaults' }),
      NotificationPolicyService.listOverrides(),
    ]);
    // A row links back to the screen that owns the scope, and that address needs a slug.
    const projectIds = [...new Set(overrides
      .map((override) => (override.scope === 'project' ? override.id : override.projectId))
      .filter((id): id is string => Boolean(id)))];
    const projects = projectIds.length > 0
      ? await AgentProject.findAll({ where: { id: projectIds }, attributes: ['id', 'slug'] })
      : [];
    return {
      policy,
      overrides,
      canEdit: hasGlobalToken(req, GLOBAL_TOKENS.notificationsManage),
      projectSlugs: Object.fromEntries(projects.map((row) => [row.id, row.slug])),
    };
  }

  if (match.name === 'admin.data') {
    // The raw CRUD of every Agentiz model, which is the whole reason the sidebar no longer carries
    // one row per table. Filtered by the same token adminizer registered for the model's own CRUD
    // page (`registerModelTokens`), so a row here always opens.
    const helper = (req?.adminizer ?? req?.runtime)?.accessRightsHelper;
    const models = await Promise.all(
      agentizDataModels().map(async (model) => {
        if (helper && req.user) {
          // `checkAnyPermission`, never the frozen `hasPermission`/`enoughPermissions` — those deny
          // a contextual token in silence while type-checking fine (AGENTS.md).
          const ok = await helper.checkAnyPermission([model.readToken], req.user);
          if (!ok) return null;
        }
        return { modelname: model.modelname, title: model.title, icon: model.icon, featured: model.featured };
      }),
    );
    return { models: models.filter(Boolean) };
  }

  return {};
}

/**
 * The two addresses of this tree whose screen belongs to `@nodeknit/app-workflow`.
 *
 * The canvas and the flow list are that package's, and this stage changes the **entry and the
 * shell** around them — our sidebar, our crumbs, our address — not the editor. So the page is
 * rendered here with the module of the other package instead of `AgentizApp`, and the props it
 * reads (`entityFilter`) are filled with the project the address names.
 *
 * The bundles are built by *this* repository's `vite.config.ts` (`WorkflowList` / `WorkflowEditor`
 * entries) into the one directory the panel serves, so `adminizerModuleUrl` spells exactly the URL
 * the package's own `workflowModuleUrl` would. It is spelled here rather than imported for the
 * reason everything else in `lib/workflow/` is type-only: a value import of that package pulls the
 * engine into the panel renderer, which must keep working when the engine app is not mounted.
 *
 * The editor takes `providerId`/`specId` from the **query string** (it reads them at module load),
 * which is why a link to one flow carries both beside the id in the path. Our address names the
 * flow; those two parameters are the other package's vocabulary and stay in its own half.
 */
function foreignModule(match: RouteMatch, project: AgentProject | null): Record<string, unknown> | null {
  if (match.name === 'project.workflows') {
    return {
      moduleComponent: adminizerModuleUrl('WorkflowList'),
      // The flows of this project and nothing else — and a flow created from here is bound to it,
      // which is the same `entity` the spec provider stores in `AgentWorkflowSpec.projectId`.
      entityFilter: project ? { model: 'AgentProject', entityId: project.id } : undefined,
    };
  }
  if (match.name === 'project.workflow') {
    return { moduleComponent: adminizerModuleUrl('WorkflowEditor') };
  }
  return null;
}

/**
 * The canvas reads `providerId`/`specId` from the query at module load, so an address that only
 * names the flow in its path would open an empty editor.
 *
 * Rather than making every link spell the other package's two parameters, the address is completed
 * here once: a flow this layer stores is served by the `agentiz` provider, so the pair is known
 * from the id alone. A `workflowId` no row matches is rendered as it is — the canvas says «не
 * найдено» itself, and a stale link from a months-old notification must not become a redirect loop
 * or a 404.
 */
async function completeWorkflowAddress(req: any, res: any, match: RouteMatch): Promise<boolean> {
  if (match.name !== 'project.workflow' || typeof req.query?.specId === 'string') return false;
  const id = match.params.workflowId;
  const row = await AgentWorkflowSpec.findByPk(id, { attributes: ['id'] });
  if (!row) return false;
  res.redirect(302, href('project.workflow', match.params, {
    providerId: AGENTIZ_WORKFLOW_PROVIDER_ID,
    specId: id,
  }));
  return true;
}

/** True when the address names a project the caller may not read — answered as 404, never 403. */
async function resolveProject(req: any, match: RouteMatch) {
  const slug = match.params.slug;
  if (!slug) return { project: null as any, denied: false };
  const project = await AgentProject.findOne({ where: { slug } });
  if (!project) return { project: null, denied: true };
  const allowed = await can(panelActor(req), project.id, PROJECT_TOKENS.read, requestAccessCache(req));
  return { project: allowed ? project : null, denied: !allowed };
}

export async function renderAgentizApp(req: any, res: any): Promise<unknown> {
  const base = baseOf(req);
  configureRouteTree(base);

  const match = matchRoute(subPathOf(req, base));
  if (!match) return res.redirect(302, href('overview'));

  const { project, denied } = await resolveProject(req, match);
  if (denied) return res.status(404).json({ message: 'Проект не найден' });

  if (await completeWorkflowAddress(req, res, match)) return undefined;

  const [menu, data] = await Promise.all([buildAgentizMenu(req, match), dataFor(req, match, project)]);

  // Decoration must never be fatal: the page is still usable without crumbs, and an exception
  // here escapes the dispatcher and kills the process rather than answering 500.
  let breadcrumbs: Array<{ title: string; href?: string }> = [];
  try {
    breadcrumbs = crumbsFor(match, project?.name ?? null, entityNameOf(match, data));
  } catch { /* falls back to no crumbs */ }

  // Левый верхний угол: подпись на кнопке и её выпадающее меню. Тоже расшаренные пропы панели
  // (`brand` / `section` в `app-sidebar.tsx`), которые проп страницы перебивает, — поэтому
  // переключатель проекта получается без единой правки в adminizer. Как и крошки, он не имеет права
  // уронить страницу: не собрался — остаётся бренд панели.
  let brandProps: { brand: string; section: unknown[] } | null = null;
  try {
    brandProps = await buildAgentizBrand(req, match) as { brand: string; section: unknown[] };
  } catch { /* остаётся панельный бренд */ }

  // Two addresses of this tree draw somebody else's screen. See `foreignModule` below.
  const foreign = foreignModule(match, project);
  if (foreign) {
    return req.Inertia.render({
      component: 'module',
      props: { ...foreign, menu, menuSections: buildAgentizSections(req), breadcrumbs, ...(brandProps ?? {}) },
    });
  }

  return req.Inertia.render({
    component: 'module',
    props: {
      moduleComponent: adminizerModuleUrl('AgentizApp'),
      moduleComponentCSS: adminizerModuleStylesheet(),
      // Page props override shared props, so these replace the panel's own sidebar for our pages.
      menu,
      menuSections: buildAgentizSections(req),
      breadcrumbs,
      ...(brandProps ?? {}),
      agentiz: {
        base,
        route: match.name,
        params: match.params,
        project: project ? { id: project.id, slug: project.slug, name: project.name } : null,
        data,
      },
    },
  });
}
