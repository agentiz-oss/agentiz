import React from 'react';
import { usePage } from '@inertiajs/react';
import { AlertTriangle, Database, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { configureRouteTree, type RouteName, type RouteParams } from '../../lib/panel/routeTree';
import { ago, plural } from './lib/format';
import { InboxScreen, type PanelInbox } from './lib/inbox';
import { StatusBadge } from './lib/status';
import type { ProjectRow } from '../../lib/panel/overviewPanel';
import { EmptyState, Page, PageHeader } from './lib/page';
import { OverviewScreen, ProjectOverviewScreen, type PanelOverview } from './lib/overview';
import {
  GlobalNotificationsScreen,
  ProjectSettingsScreen,
  type PolicyOverride,
  type PolicyScopeView,
  type ProjectSettingsData,
} from './lib/settings';
import {
  GitProviderScreen,
  GitProvidersScreen,
  ProjectRepositoriesScreen,
  type GitProviderCard,
  type ProjectRepositoryRow,
} from './lib/repositories';
import { PipelineScreen, PipelinesScreen } from './lib/pipelines';
import type { PanelPipelineBoard } from '../../lib/panel/pipelinesPanel';
import { RunScreen, RunsScreen, type RunList } from './lib/runs';
import { HarnessesScreen, WorkerScreen, WorkersScreen, type WorkerFleet } from './lib/workers';
import { TaskScreen, TasksScreen, type TaskList } from './lib/tasks';

/**
 * One module for the whole `/agentiz` address tree.
 *
 * Navigation is Inertia, not a client-side router: the sidebar, the breadcrumbs and the help
 * button are **per-request page props**, so a transition that does not reach the server leaves
 * them frozen — and a contextual sidebar that does not follow the address is the one feature this
 * rework exists for. Tabs and filters are a different matter and stay in the query string.
 *
 * Props are read through `usePage()`. Since adminizer 5.1.0-build.28 the component argument is
 * live too, but one reading point beats threading props through every screen.
 */

interface AgentizPageProps {
  base: string;
  route: RouteName;
  params: RouteParams;
  project: { id: string; slug: string; name: string } | null;
  data: Record<string, any>;
}

const PREFIX: string = (window as any).routePrefix ?? '/dashboard';

/**
 * «Проекты» — список, а не сетка карточек.
 *
 * Карточки говорили только имя и слаг, поэтому выбор между проектами делался наугад. Строка
 * повторяет строку списка запусков и задач: слева имя и описание, справа состояние и три числа,
 * по которым проекты и сравнивают — открытые задачи, идущие запуски и когда в проекте последний
 * раз что-то происходило. Числа считает сервер теми же читателями, что и экраны за ними
 * (`lib/panel/overviewPanel.ts`, `projectRows`).
 */
function ProjectsScreen({ data }: { data: Record<string, any> }) {
  const projects: ProjectRow[] = data.projects ?? [];
  const active = projects.filter((project) => project.isActive).length;
  return (
    <>
      <PageHeader
        title="Проекты"
        meta={[
          `${projects.length} ${plural(projects.length, 'проект', 'проекта', 'проектов')}`,
          active < projects.length ? `${active} активных` : null,
        ]}
        actions={
          <Button asChild>
            <a href={`${PREFIX}/model/AgentProject/add`}><Plus /> Новый проект</a>
          </Button>
        }
      />
      {projects.length === 0 ? (
        <EmptyState title="Проектов пока нет" description="Создайте первый проект, чтобы начать." />
      ) : (
        <ul className="divide-y rounded-lg border">
          {projects.map((project) => (
            <li key={project.id} className="flex items-center gap-4 px-4 py-3 hover:bg-accent/40">
              <div className="min-w-0 flex-1">
                <a href={project.href} className="text-sm font-medium hover:underline">{project.name}</a>
                <p className="truncate text-xs text-muted-foreground">{project.description || project.slug}</p>
              </div>
              <StatusBadge status={project.isActive ? 'active' : 'inactive'} />
              <span className="w-28 text-right text-xs text-muted-foreground max-md:hidden">
                {project.openTasks} {plural(project.openTasks, 'задача', 'задачи', 'задач')}
              </span>
              <span className="w-28 text-right text-xs text-muted-foreground max-md:hidden">
                {project.activeRuns} {plural(project.activeRuns, 'запуск', 'запуска', 'запусков')}
              </span>
              <span className="w-32 text-right text-xs text-muted-foreground">
                {project.lastActivityAt ? ago(project.lastActivityAt) : '—'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * «Модели данных» — сырой CRUD, свёрнутый из строки сайдбара на каждую таблицу в один раздел.
 *
 * Список, а не сетка карточек: имя таблицы моноширинное, потому что его копируют в MCP-вызов и в
 * миграцию, а карточка в три колонки делает из двадцати шести имён стену. Врезка сверху — не
 * украшение: правка строки в обход продуктовых экранов обходит и проверки (спеку, привязку папки
 * к проекту, лестницу ролей), и это единственное место панели, где так можно.
 */
function DataModelsScreen({ data }: { data: Record<string, any> }) {
  const models: Array<{ modelname: string; title: string; icon: string; featured: boolean }> = data.models ?? [];
  const groups: Array<[string, typeof models]> = [
    ['Рабочие таблицы', models.filter((model) => model.featured)],
    ['Служебные таблицы', models.filter((model) => !model.featured)],
  ];

  return (
    <>
      <PageHeader
        title="Модели данных"
        meta={`${models.length} ${plural(models.length, 'таблица', 'таблицы', 'таблиц')}`}
        description="Прямой доступ к таблицам. Обычная работа идёт через разделы продукта."
      />
      {models.length === 0 ? (
        <EmptyState title="Ни одной таблицы" description="Либо ничего не зарегистрировано, либо у вас нет прав на чтение." />
      ) : (
        <>
          <div className="mb-6 flex items-start gap-3 rounded-lg border border-warning/50 bg-warning/10 p-4">
            <AlertTriangle className="agentiz-attention mt-0.5 size-4 shrink-0" />
            <div className="text-sm">
              <div className="font-medium">Для продвинутых</div>
              <p className="mt-1 text-muted-foreground">
                Правка строк в обход продуктовых экранов обходит и проверки: спеку, привязку папки к проекту,
                лестницу ролей.
              </p>
            </div>
          </div>
          <div className="space-y-6">
            {groups.map(([group, rows]) => rows.length === 0 ? null : (
              <div key={group}>
                <h2 className="mb-2 text-sm font-semibold">{group}</h2>
                <ul className="divide-y rounded-lg border">
                  {rows.map((model) => (
                    <li key={model.modelname} className="flex items-center gap-3 px-4 py-2 hover:bg-accent/40">
                      <Database className="size-3.5 shrink-0 text-muted-foreground" />
                      <a
                        href={`${PREFIX}/model/${model.modelname}`}
                        className="min-w-0 flex-1 truncate font-mono text-sm hover:underline"
                      >
                        {model.modelname}
                      </a>
                      <span className="w-48 truncate text-right text-xs text-muted-foreground max-sm:hidden">{model.title}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

const WIDE: RouteName[] = ['project.workflow'];
const NARROW: RouteName[] = ['project.settings', 'settings.notifications'];

/**
 * Раскрывает все секции сайдбара — временная замена настройке, которой в adminizer пока нет.
 *
 * Его `NavMain` рисует каждую секцию свёрнутым `Collapsible` и открывает **ровно одну** — ту, где
 * активный пункт. Макет `ui-1-sol` показывает все: в глобальном режиме это 10 строк против 6, и
 * «Воркеры» из «Обзора» достаются не кликом, а двумя. CSS тут бессилен — содержимое закрытой
 * секции не отрисовано вовсе (`{isOpenNow && …}`), поэтому единственный способ из модуля — тот же
 * жест, что и у человека: клик по подписи секции.
 *
 * Три вещи делают этот костыль безопасным. Он **идемпотентен** — кликает только там, где нет
 * `sidebar-group-content`, то есть уже открытую секцию не закрывает. Он **не трогает узкий режим**:
 * в rail-виде у секции нет `sidebar-group-label`, и `querySelector` вернёт `null`. И он
 * **ограничен нашим деревом** — эффект живёт в нашем модуле и не выполняется на чужих страницах
 * панели.
 *
 * Цена, которую надо знать: секция, свёрнутая человеком вручную, снова раскроется при следующем
 * переходе. Это осознанный компромисс до просьбы A1 (`menuSections[…].collapsible: false`); когда
 * она приедет, функцию нужно удалить целиком, а не оставлять «на всякий случай».
 */
function useExpandedSidebarSections(key: string): void {
  React.useEffect(() => {
    const expand = () => {
      document.querySelectorAll('[data-slot="sidebar-group"]').forEach((group) => {
        if (group.querySelector('[data-slot="sidebar-group-content"]')) return;
        (group.querySelector('[data-slot="sidebar-group-label"]') as HTMLElement | null)?.click();
      });
    };
    expand();
    // Второй проход кадром позже: сайдбар и наш модуль монтируются в одном коммите, и порядок
    // между ними ничем не гарантирован — без этого на первой загрузке иногда раскрывать нечего.
    const frame = requestAnimationFrame(expand);
    return () => cancelAnimationFrame(frame);
  }, [key]);
}

const AgentizApp: React.FC = () => {
  const page = usePage<any>();
  const ctx = (page.props?.agentiz ?? {}) as AgentizPageProps;

  // The tree is mounted under the configured `routePrefix`, which only the server knows for sure.
  configureRouteTree(ctx.base ?? `${PREFIX}/agentiz`);

  useExpandedSidebarSections(`${ctx.route}:${ctx.project?.slug ?? ''}`);

  const width = WIDE.includes(ctx.route) ? 'wide' : NARROW.includes(ctx.route) ? 'narrow' : 'default';

  /**
   * The address, as a React key.
   *
   * Every screen in this tree renders from the one component the panel loaded, so an Inertia visit
   * from one address to another gives React the same element type and it keeps the instance — with
   * the state seeded from the *previous* page's props. A screen started from `useState(initial)`
   * would then show one project's runs under another project's sidebar. Remounting on the address
   * is both cheaper to reason about and what a person expects from following a link.
   */
  const screenKey = `${ctx.route}:${Object.entries(ctx.params ?? {}).map(([name, value]) => `${name}=${value}`).join('&')}`;

  // Screens that bring their own <Page>, because their width is theirs to choose: the inbox is a
  // master/detail, and a run is narrow on its overview and full-width on its log and its diff.
  if (ctx.route === 'inbox' && ctx.data?.inbox) {
    return <InboxScreen key={screenKey} initial={ctx.data.inbox as PanelInbox} />;
  }
  if ((ctx.route === 'runs' || ctx.route === 'project.runs') && ctx.data?.runs) {
    return (
      <RunsScreen
        key={screenKey}
        initial={ctx.data.runs as RunList}
        projectId={ctx.route === 'project.runs' ? ctx.project?.id ?? null : null}
        initialStatus={String(ctx.data.status ?? '')}
      />
    );
  }
  if (ctx.route === 'project.run' && ctx.params?.runId && ctx.project) {
    return <RunScreen key={screenKey} runId={ctx.params.runId} slug={ctx.project.slug} found={ctx.data?.found === true} />;
  }
  if (ctx.route === 'project.tasks' && ctx.data?.tasks && ctx.project) {
    return (
      <TasksScreen
        key={screenKey}
        initial={ctx.data.tasks as TaskList}
        projectId={ctx.project.id}
        slug={ctx.project.slug}
        initialView={String(ctx.data.view ?? '')}
        initialPriority={String(ctx.data.priority ?? '')}
        initialSearch={String(ctx.data.search ?? '')}
        priorities={(ctx.data.filters?.priorities ?? []) as string[]}
      />
    );
  }
  if (ctx.route === 'project.task' && ctx.params?.taskId && ctx.project) {
    return (
      <TaskScreen
        key={screenKey}
        taskId={ctx.params.taskId}
        slug={ctx.project.slug}
        found={ctx.data?.found === true}
        statuses={(ctx.data?.filters?.statuses ?? []) as string[]}
        priorities={(ctx.data?.filters?.priorities ?? []) as string[]}
      />
    );
  }

  const body = (() => {
    if (ctx.route === 'projects') return <ProjectsScreen data={ctx.data ?? {}} />;
    // The two overviews are made of other screens' numbers on purpose (`lib/panel/overviewPanel.ts`):
    // the inbox's own rows, the run board's own builder and the activity feed.
    if (ctx.route === 'overview' && ctx.data?.overview) {
      return <OverviewScreen key={screenKey} data={ctx.data.overview as PanelOverview} />;
    }
    if (ctx.route === 'project.overview' && ctx.data?.overview && ctx.project) {
      return <ProjectOverviewScreen key={screenKey} data={ctx.data.overview as PanelOverview} project={ctx.project} />;
    }
    // Four sections behind one address; `dataFor` fills only the one the address names.
    if (ctx.route === 'project.settings' && ctx.data?.settings && ctx.project) {
      return <ProjectSettingsScreen key={screenKey} data={ctx.data.settings as ProjectSettingsData} project={ctx.project} />;
    }
    if (ctx.route === 'settings.notifications' && ctx.data?.policy) {
      return (
        <GlobalNotificationsScreen
          key={screenKey}
          policy={ctx.data.policy as PolicyScopeView}
          overrides={(ctx.data.overrides ?? []) as PolicyOverride[]}
          canEdit={ctx.data.canEdit === true}
          projectSlugs={(ctx.data.projectSlugs ?? {}) as Record<string, string>}
        />
      );
    }
    // The fleet: one server answer (`fleet`) serves all three screens — a machine, its bindings and
    // the accounts behind them are read from both ends and must not word a state two ways.
    if (ctx.route === 'workers' && ctx.data?.fleet) {
      return <WorkersScreen key={screenKey} initial={ctx.data.fleet as WorkerFleet} />;
    }
    if (ctx.route === 'worker' && ctx.data?.fleet && ctx.params?.workerId) {
      return <WorkerScreen key={screenKey} initial={ctx.data.fleet as WorkerFleet} workerId={ctx.params.workerId} />;
    }
    if (ctx.route === 'harnesses' && ctx.data?.fleet) {
      return <HarnessesScreen key={screenKey} initial={ctx.data.fleet as WorkerFleet} />;
    }
    if (ctx.route === 'admin.data') return <DataModelsScreen data={ctx.data ?? {}} />;

    // One server answer (`board`) serves both pipeline screens: a row has to say what a pipeline
    // works on, which is the same worker and repository the editor picks from.
    if (ctx.route === 'project.pipelines' && ctx.data?.board && ctx.project) {
      return <PipelinesScreen initial={ctx.data.board as PanelPipelineBoard} slug={ctx.project.slug} />;
    }
    if (ctx.route === 'project.pipeline' && ctx.data?.board && ctx.project && ctx.params?.specId) {
      return (
        <PipelineScreen
          initial={ctx.data.board as PanelPipelineBoard}
          slug={ctx.project.slug}
          projectId={ctx.project.id}
          specId={ctx.params.specId}
        />
      );
    }

    if (ctx.route === 'project.repositories' && ctx.project) {
      return (
        <ProjectRepositoriesScreen
          initial={(ctx.data?.repositories ?? []) as ProjectRepositoryRow[]}
          projectId={ctx.project.id}
          canConfigure={ctx.data?.canConfigure === true}
          canManageConnections={ctx.data?.canManageConnections === true}
        />
      );
    }
    // Installation-wide, so the refusal is a state of the screen rather than a 404: the address is
    // reachable, the person simply does not hold `agentiz-connections-manage`.
    if (ctx.route === 'integrations.git') {
      return ctx.data?.denied
        ? <EmptyState title="Недостаточно прав" description="Git-подключения настраивают администраторы установки." />
        : <GitProvidersScreen providers={(ctx.data?.providers ?? []) as GitProviderCard[]} />;
    }
    if (ctx.route === 'integrations.gitProvider') {
      return ctx.data?.denied
        ? <EmptyState title="Недостаточно прав" description="Git-подключения настраивают администраторы установки." />
        : <GitProviderScreen provider={(ctx.data?.provider ?? null) as GitProviderCard | null} />;
    }

    // Every address of the tree is answered above. Reaching here means `dataFor()` returned
    // nothing for a route that exists — a project deleted between the menu and the click, say —
    // so it is a state of the screen rather than a blank page.
    return <EmptyState title="Неизвестный раздел" description={String(ctx.route ?? '')} />;
  })();

  return <Page width={width}>{body}</Page>;
};

export default AgentizApp;
