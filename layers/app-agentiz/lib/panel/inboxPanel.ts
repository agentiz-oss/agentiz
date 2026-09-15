import { AgentProject } from '../../models/AgentProject';
import type { AgentTask } from '../../models/AgentTask';
import { projectIdsForUser } from '../access/projectAccess';
import { panelActor, requestAccessCache } from '../access/panelGuard';
import { PROJECT_TOKENS } from '../access/tokens';
import {
  collectInboxItems,
  collectTaskInboxItems,
  isBlockingInboxItem,
  workerAlerts,
  type InboxItem,
} from '../inbox';
import { href } from './routeTree';

/**
 * The inbox as the **panel** reads it.
 *
 * The rows are not built here: they come from `lib/inbox/`, the same code the phone reads, because
 * a screen and a badge computing "что меня ждёт" from two pieces of code is how the two start
 * disagreeing about the same four rows. What this file adds is the two things that are the panel's
 * own and would be wrong on a phone:
 *
 * * **an address.** A row carries `projectId`/`runId`/`taskId`; a panel link needs a slug and a
 *   route. That is resolved once, on the server, so `href()` stays the only thing that spells an
 *   address — a row arriving at the browser with an id and no link would put route-building back
 *   into the module.
 * * **the scope.** `projectIdsForUser(actor, read)` with the panel actor, which — unlike the
 *   phone's — honours the administrator flag and the bypass token.
 *
 * What is deliberately **absent** is the dismissal («скрыл напоминание»): it is a mobile model and
 * a swipe gesture, and the panel showing a reminder it cannot hide is the pre-existing, honest
 * state — a reminder holds nothing, so nothing is stuck because of it.
 */

/** A row plus what the panel needs to draw a link to it. Never sent to the phone. */
export interface PanelInboxItem extends InboxItem {
  projectSlug: string | null;
  /** Where the decision is actually made — the run, or the task when there is no run. */
  href: string | null;
  /** True when this row holds something: what the header and the sidebar badge count. */
  blocking: boolean;
}

export interface PanelInbox {
  items: PanelInboxItem[];
  /** Rows that hold something. The one number the sidebar badge and the header both use. */
  actionableCount: number;
  /** Rows that hold nothing and that nobody ever closes — shown, never counted. */
  reminderCount: number;
  workerAlerts: { needLogin: number; offline: number };
}

/**
 * Where a row is decided. A run when the row names one — every kind but `approval` does — and the
 * task otherwise, because an approval is about the work, not about one attempt at it.
 *
 * `null` when the project is gone from under the row: a link that would throw is worse than a row
 * that is merely not clickable, and `href` throws by design on a missing parameter.
 */
function linkFor(item: InboxItem, slug: string | null): string | null {
  if (!slug) return null;
  if (item.runId) return href('project.run', { slug, runId: item.runId });
  if (item.taskId) return href('project.task', { slug, taskId: item.taskId });
  return href('project.overview', { slug });
}

/** Everything waiting on the person behind this request, across the projects they may read. */
export async function panelInbox(req: any): Promise<PanelInbox> {
  const actor = panelActor(req);
  const cache = requestAccessCache(req);
  const projectIds = await projectIdsForUser(actor, PROJECT_TOKENS.read, cache);

  const [{ items }, alerts] = await Promise.all([
    collectInboxItems({ projectIds, actor }),
    workerAlerts(),
  ]);

  const projects = await AgentProject.findAll({
    where: { id: [...new Set(items.map((item) => item.projectId))] },
    attributes: ['id', 'slug'],
  });
  const slugById = new Map(projects.map((project) => [project.id, project.slug]));

  const shaped = items.map((item) => {
    const slug = slugById.get(item.projectId) ?? null;
    return { ...item, projectSlug: slug, href: linkFor(item, slug), blocking: isBlockingInboxItem(item) };
  });

  return {
    items: shaped,
    actionableCount: shaped.filter((item) => item.blocking).length,
    reminderCount: shaped.length - shaped.filter((item) => item.blocking).length,
    workerAlerts: alerts,
  };
}

/**
 * The same rows, narrowed to one task — the «требует внимания» strip above a task's own screen.
 *
 * It is the panel's half of what the phone reads as `actionRequired` in `GET /tasks/:id`, and it
 * goes through `collectTaskInboxItems` for the reason the whole inbox moved into the core: a task
 * screen composing its own «агент ждёт ответа» из своих полей is a third surface naming one event
 * a third way. The words, the facts and the buttons are the server's here too.
 *
 * The caller has already checked the right to read this task (`guardTask`), so the scope is the
 * task itself; the actor still travels because an approval is addressed to somebody and a row
 * nobody may decide must not be shown with buttons.
 */
export async function panelTaskInbox(
  req: any,
  task: AgentTask,
  project: AgentProject | null,
): Promise<PanelInboxItem[]> {
  const items = await collectTaskInboxItems(task, project, panelActor(req));
  const slug = project?.slug ?? null;
  return items.map((item) => ({
    ...item,
    projectSlug: slug,
    href: linkFor(item, slug),
    blocking: isBlockingInboxItem(item),
  }));
}

/**
 * Just the number, for the sidebar.
 *
 * The same `actionableCount` the screen prints and the phone's inbox shows — deliberately not the
 * phone's *app icon* badge, which subtracts what the notification policy mutes for push. A muted
 * type means "не дёргай меня", not "этого нет", and a sidebar the reader is already looking at is
 * not a poke.
 */
export async function panelInboxCount(req: any): Promise<number> {
  return (await panelInbox(req)).actionableCount;
}
