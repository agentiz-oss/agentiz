import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../models';
import { AgentProject } from '../models/AgentProject';
import { AgentTask } from '../models/AgentTask';
import { AgentTaskService } from './AgentTaskService';
import { taskViewStatuses } from '../lib/taskViews';

/**
 * The query behind the task board.
 *
 * Two things are pinned here and each of them is a way the board silently lies otherwise: that the
 * tab filter is the **server's** job (the page is capped, so a tab filtered in the browser answers
 * «упавших нет» over a failure that is simply past the limit), and that the tally beside every tab
 * counts the *other* tabs too rather than the one that is open.
 *
 * The first test is the backward-compatibility proof the repository asks for before a filter is
 * added to a shared reader: a call written before `statuses` existed — which is every call the old
 * screen still makes — has to come out the other end unchanged.
 */
describe('AgentTaskService, as the task board reads it', () => {
  let sequelize: Sequelize;
  let mine: AgentProject;
  let theirs: AgentProject;

  async function makeTask(project: AgentProject, status: string, over: Record<string, unknown> = {}) {
    return AgentTask.create({
      projectId: project.id,
      externalId: `local:${Math.random()}`,
      title: 'Задача',
      status,
      priority: 'normal',
      ...over,
    } as any);
  }

  beforeEach(async () => {
    sequelize = new Sequelize({
      dialect: 'sqlite', storage: ':memory:', logging: false,
      models: Object.values(agentizModels) as any[],
    });
    await sequelize.sync({ force: true });
    mine = await AgentProject.create({ name: 'Мой', slug: 'mine', ownerId: 1 } as any);
    theirs = await AgentProject.create({ name: 'Чужой', slug: 'theirs', ownerId: 2 } as any);
  });

  it('answers a call written before the tabs existed exactly as it did then', async () => {
    await makeTask(mine, 'new');
    await makeTask(mine, 'done');
    await makeTask(theirs, 'new');

    // No `statuses`, no `status` — the shape the old screen sends on every request.
    const all = await AgentTaskService.list({ projectId: mine.id });
    expect(all.items).toHaveLength(2);
    expect(all.total).toBe(2);

    // And the single-status filter it also sends still narrows on its own.
    const done = await AgentTaskService.list({ projectId: mine.id, status: 'done' });
    expect(done.items).toHaveLength(1);
    expect(done.total).toBe(1);

    // An empty array is "no condition", not "nothing matches" — that is what «Все» sends.
    const empty = await AgentTaskService.list({ projectId: mine.id, statuses: [] });
    expect(empty.items).toHaveLength(2);
  });

  it('reads only the projects it was given', async () => {
    await makeTask(mine, 'new');
    await makeTask(theirs, 'new');

    // `adminizerMiddlewares` mount before Adminizer's policies and this query bypasses the access
    // graph entirely, so the id list is the whole scoping there is.
    const visible = await AgentTaskService.list({ projectIds: [mine.id] });
    expect(visible.items).toHaveLength(1);
    expect(visible.total).toBe(1);
    expect(visible.statusCounts).toEqual({ new: 1 });
  });

  it('finds a task the browser could not have found', async () => {
    // Older than a page of the board, which is the whole reason the tab is applied in SQL.
    const old = await makeTask(mine, 'failed');
    for (let index = 0; index < 30; index += 1) await makeTask(mine, 'done');

    const page = await AgentTaskService.list({ projectId: mine.id, limit: 25 });
    expect(page.items.some((task: any) => task.id === old.id)).toBe(false);

    const failures = await AgentTaskService.list({
      projectId: mine.id,
      limit: 25,
      statuses: taskViewStatuses('open'),
    });
    expect(failures.items.map((task: any) => task.id)).toEqual([old.id]);
  });

  it('counts every tab, not the open one', async () => {
    await makeTask(mine, 'new');
    await makeTask(mine, 'running');
    await makeTask(mine, 'done');
    await makeTask(mine, 'done');

    const open = await AgentTaskService.list({ projectId: mine.id, statuses: taskViewStatuses('open') });
    expect(open.items).toHaveLength(2);
    // Counted inside the current tab, «Готовые» would read 0 while holding two tasks.
    expect(open.statusCounts).toEqual({ new: 1, running: 1, done: 2 });
  });

  it('opens a task in a project that has no pipeline yet', async () => {
    // `buildRunOptions` resolves the spec a launch would use and throws when there is none — an
    // ordinary state for a project that was created five minutes ago. Inside `Promise.all` that
    // rejection used to take the **whole** payload with it, so the task could not be opened at all:
    // no description, no thread, no files, just «No active pipeline spec for project …».
    const task = await makeTask(mine, 'new', { description: 'Что-то сделать' });

    const details = await AgentTaskService.details(task.id) as any;

    expect(details.task.title).toBe('Задача');
    expect(details.task.description).toBe('Что-то сделать');
    expect(details.comments).toEqual([]);
    // Only the part that really is unavailable goes missing, and it says so by being null.
    expect(details.runOptions).toBeNull();
    expect(details.manualExecutorOptions).toEqual([]);
  });

  it('narrows the tally by everything except the status', async () => {
    await makeTask(mine, 'new', { priority: 'high' });
    await makeTask(mine, 'done', { priority: 'high' });
    await makeTask(mine, 'done', { priority: 'low' });

    const high = await AgentTaskService.list({ projectId: mine.id, priority: 'high' });
    // A person who filtered by priority is asking about those tasks on every tab, not about all.
    expect(high.statusCounts).toEqual({ new: 1, done: 1 });
  });
});
