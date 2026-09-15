import { Op } from 'sequelize';
import { AgentActivity } from '../../models/AgentActivity';
import { AgentProject } from '../../models/AgentProject';
import { AgentTask } from '../../models/AgentTask';
import { AgentWorker } from '../../models/AgentWorker';
import { activityTypes } from '../notifications/activityTypes';
import { panelActor, requestAccessCache } from '../access/panelGuard';
import { projectIdsForUser } from '../access/projectAccess';
import { PROJECT_TOKENS } from '../access/tokens';
import { listRuns } from '../runBoard';
import { taskViewStatuses } from '../taskViews';
import { panelInbox, type PanelInboxItem } from './inboxPanel';
import { href } from './routeTree';

/**
 * The two overview screens — «Обзор» over every project and the overview of one project.
 *
 * They are deliberately the last thing ported and they are deliberately made of other people's
 * numbers. An overview whose figures are computed here would be a second opinion about how many
 * tasks are open and what is waiting for a person, and the first time it disagreed with the screen
 * it links to, both would stop being read. So:
 *
 * * «требует внимания» is `lib/inbox/` through `panelInbox` — the same rows the inbox screen, the
 *   sidebar badge and the phone show, filtered to the blocking ones and cut to the first few;
 * * «идёт сейчас» is `listRuns` — the same builder the run board is painted from, which is also
 *   where a run's current stage comes from (`stages[]` + `currentStageIndex`), so the word beside
 *   a run here and on the board is one word;
 * * «последние события» is the `AgentActivity` feed, named with the `badge` from
 *   `activityTypes.ts` rather than a caption invented for this screen.
 *
 * Nothing here polls. The blocks that move are the two above, and each of them links to a screen
 * that does — while collecting the whole inbox on a timer, for every open overview tab, is the
 * most expensive query the panel already makes once per page for the sidebar badge.
 */

/** The counters across the top. Every one of them is also the caption of a link. */
export interface OverviewStats {
  openTasks: number;
  activeRuns: number;
  workersOnline: number;
  workersTotal: number;
  /** Rows that hold something — `actionableCount` of the inbox, not a second count of it. */
  actionable: number;
  /** Projects in scope; on a project's own overview both numbers are that project alone. */
  projects: number;
  activeProjects: number;
}

/** One line of the feed: what happened, when, and where it is read in full. */
export interface OverviewActivityRow {
  id: string;
  type: string;
  /** From `activityTypes.ts`; absent for a type this build no longer knows about. */
  badge: string | null;
  title: string;
  createdAt: string;
  projectSlug: string | null;
  projectName: string | null;
  href: string | null;
}

export interface PanelOverview {
  /**
   * The two facts of a project the page prop does not carry (it is `{id, slug, name}` for every
   * screen in the tree). Null on the global overview.
   */
  project: { description: string | null; isActive: boolean } | null;
  stats: OverviewStats;
  /** Blocking rows only, newest question first — the reminders live on the inbox screen. */
  attention: PanelInboxItem[];
  /** Runs in flight, straight out of `listRuns().active`. */
  running: any[];
  activity: OverviewActivityRow[];
}

/** Which task statuses «открытая задача» means — the board's own «Открытые» tab, not a copy of it. */
const OPEN_TASK_STATUSES = taskViewStatuses('open')!;

/** How many rows of each list the overview shows before sending the reader to the full screen. */
const ATTENTION_LIMIT = 5;
const ACTIVITY_LIMIT = 8;

/**
 * Where an activity row is read in full. The same three-way choice `inboxPanel.linkFor` makes, and
 * for the same reason: a row carries ids, and only the server knows the slug an address needs.
 */
function activityHref(row: AgentActivity, slug: string | null): string | null {
  if (!slug) return null;
  if (row.runId) return href('project.run', { slug, runId: row.runId });
  if (row.taskId) return href('project.task', { slug, taskId: row.taskId });
  return href('project.overview', { slug });
}

async function activityRows(projectIds: string[]): Promise<OverviewActivityRow[]> {
  if (projectIds.length === 0) return [];
  const rows = await AgentActivity.findAll({
    where: { projectId: { [Op.in]: projectIds } },
    order: [['createdAt', 'DESC']],
    limit: ACTIVITY_LIMIT,
  });
  if (rows.length === 0) return [];

  const projects = await AgentProject.findAll({
    where: { id: [...new Set(rows.map((row) => row.projectId))] },
    attributes: ['id', 'slug', 'name'],
  });
  const byId = new Map(projects.map((project) => [project.id, project]));
  const badges = new Map(activityTypes().map((def) => [def.type, def.badge]));

  return rows.map((row) => {
    const project = byId.get(row.projectId) ?? null;
    return {
      id: row.id,
      type: row.type,
      badge: badges.get(row.type) ?? null,
      title: row.title,
      createdAt: new Date(row.createdAt).toISOString(),
      projectSlug: project?.slug ?? null,
      projectName: project?.name ?? null,
      href: activityHref(row, project?.slug ?? null),
    };
  });
}

/**
 * Machines reachable right now. A worker belongs to no project until an allowlist says so, so an
 * empty allowlist counts as «этому проекту тоже» — the same rule the claim gate applies, and the
 * same one `getProjectStats` has always printed.
 */
async function workerCounts(projectId: string | null): Promise<{ online: number; total: number }> {
  const workers = await AgentWorker.findAll();
  const mine = projectId
    ? workers.filter((worker) => !worker.allowedProjectIds?.length || worker.allowedProjectIds.includes(projectId))
    : workers;
  return {
    total: mine.length,
    online: mine.filter((worker) => worker.status === 'active' && worker.contactState() === 'online').length,
  };
}

/** The shared half: everything is the same question asked of one project or of all of them. */
async function build(
  req: any,
  projectIds: string[],
  project: AgentProject | null,
): Promise<PanelOverview> {
  const projectId = project?.id ?? null;
  const [inbox, runs, openTasks, workers, activity, activeProjects] = await Promise.all([
    panelInbox(req),
    projectId ? listRuns(projectId) : listRuns('', projectIds),
    projectIds.length > 0
      ? AgentTask.count({ where: { projectId: { [Op.in]: projectIds }, status: { [Op.in]: OPEN_TASK_STATUSES } } })
      : Promise.resolve(0),
    workerCounts(projectId),
    activityRows(projectIds),
    projectIds.length > 0
      ? AgentProject.count({ where: { id: { [Op.in]: projectIds }, isActive: true } })
      : Promise.resolve(0),
  ]);

  // One project's overview shows one project's rows; the inbox itself is always collected over
  // everything the person may read, because that is what the sidebar badge counts.
  const mine = projectId ? inbox.items.filter((item) => item.projectId === projectId) : inbox.items;
  const attention = mine.filter((item) => item.blocking);

  return {
    project: project ? { description: project.description ?? null, isActive: project.isActive } : null,
    stats: {
      openTasks,
      activeRuns: runs.active.length,
      workersOnline: workers.online,
      workersTotal: workers.total,
      actionable: attention.length,
      projects: projectIds.length,
      activeProjects,
    },
    attention: attention.slice(0, ATTENTION_LIMIT),
    running: runs.active,
    activity,
  };
}

/** «Обзор» — across every project this person may read. */
export async function globalOverview(req: any): Promise<PanelOverview> {
  const projectIds = await projectIdsForUser(panelActor(req), PROJECT_TOKENS.read, requestAccessCache(req));
  return build(req, projectIds, null);
}

/** The overview of one project. The caller has already checked that it may be read. */
export async function projectOverview(req: any, project: AgentProject): Promise<PanelOverview> {
  return build(req, [project.id], project);
}
