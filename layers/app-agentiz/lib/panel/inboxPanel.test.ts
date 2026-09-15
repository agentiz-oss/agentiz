import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../../models';
import { AgentProject } from '../../models/AgentProject';
import { AgentRun } from '../../models/AgentRun';
import { AgentRunInteraction } from '../../models/AgentRunInteraction';
import { AgentRunJob } from '../../models/AgentRunJob';
import { AgentStageExecution } from '../../models/AgentStageExecution';
import { AgentTask } from '../../models/AgentTask';
import { collectInboxItems } from '../inbox';
import { configureRouteTree } from './routeTree';
import { panelInbox, panelInboxCount } from './inboxPanel';

/**
 * The panel reads the inbox through the same `lib/inbox/` the phone does; what this file pins down
 * is the two things the panel adds on top — the address of a row and the scope it is read in — and
 * the one thing that must stay true of both readers: the same entities produce the same rows.
 */
describe('panelInbox', () => {
  let sequelize: Sequelize;
  let mine: AgentProject;
  let theirs: AgentProject;

  const OWNER = 41;
  const STRANGER = 42;

  /** The half of an express request the access helpers and the shaping actually read. */
  const request = (userId: number) => ({
    user: { id: userId, login: `u${userId}` },
    session: { UserAP: { id: userId, login: `u${userId}` } },
  });

  /** A run parked on a question — the simplest row that is blocking and belongs to a run. */
  async function askQuestion(project: AgentProject, task: AgentTask) {
    const run = await AgentRun.create({
      projectId: project.id, taskId: task.id, status: 'waiting_input', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
    } as any);
    const job = await AgentRunJob.create({
      runId: run.id, projectId: project.id, status: 'running', attempt: 1, snapshot: {},
    } as any);
    const stage = await AgentStageExecution.create({
      runId: run.id, stageIndex: 0, role: 'implement', status: 'waiting_input',
    } as any);
    await AgentRunInteraction.create({
      projectId: project.id, runId: run.id, jobId: job.id, attempt: 1, stageExecutionId: stage.id,
      kind: 'elicitation', source: 'codex', externalRequestId: `req-${run.id}`, message: 'Так или иначе?',
      requestedSchema: { type: 'object', properties: {} }, status: 'pending',
    } as any);
    return run;
  }

  beforeEach(async () => {
    delete process.env.AGENTIZ_NOTIFY_POLICY;
    configureRouteTree('/dashboard/agentiz');
    sequelize = new Sequelize({
      dialect: 'sqlite', storage: ':memory:', logging: false,
      models: Object.values(agentizModels) as any[],
    });
    await sequelize.sync({ force: true });

    mine = await AgentProject.create({ name: 'Мой', slug: 'mine', ownerId: OWNER } as any);
    theirs = await AgentProject.create({ name: 'Чужой', slug: 'theirs', ownerId: STRANGER } as any);
  });

  it('shows a row where the decision is made, on the new address tree', async () => {
    const task = await AgentTask.create({
      projectId: mine.id, externalId: 'local:1', title: 'Задача', status: 'running', priority: 'normal',
    } as any);
    const run = await askQuestion(mine, task);

    const inbox = await panelInbox(request(OWNER));

    expect(inbox.items).toHaveLength(1);
    // Not `/dashboard/agentiz-runs?runId=…`: a link spelled by hand anywhere but `href()` is how
    // the sidebar, the crumbs and the buttons start disagreeing.
    expect(inbox.items[0].href).toBe(`/dashboard/agentiz/projects/mine/runs/${run.id}`);
    expect(inbox.items[0].projectSlug).toBe('mine');
    expect(inbox.items[0].blocking).toBe(true);
    expect(inbox.actionableCount).toBe(1);
    expect(inbox.reminderCount).toBe(0);
  });

  it('reads exactly the projects the caller may read', async () => {
    for (const project of [mine, theirs]) {
      const task = await AgentTask.create({
        projectId: project.id, externalId: `local:${project.slug}`, title: 'Задача', status: 'running', priority: 'normal',
      } as any);
      await askQuestion(project, task);
    }

    expect((await panelInbox(request(OWNER))).items.map((item) => item.projectSlug)).toEqual(['mine']);
    expect((await panelInbox(request(STRANGER))).items.map((item) => item.projectSlug)).toEqual(['theirs']);
    // Nothing of their own and no error: an empty scope means "nothing to look at", never "all".
    expect((await panelInbox(request(99))).items).toEqual([]);
  });

  it('is the same list the phone gets, from the same code', async () => {
    const task = await AgentTask.create({
      projectId: mine.id, externalId: 'local:1', title: 'Задача', status: 'running', priority: 'normal',
    } as any);
    await askQuestion(mine, task);

    const panel = await panelInbox(request(OWNER));
    const shared = await collectInboxItems({ projectIds: [mine.id], actor: OWNER });

    // The panel adds three fields and changes none: a screen that re-derived a badge or a headline
    // would be the third place naming one event, which is what the catalogue exists to prevent.
    expect(panel.items.map(({ projectSlug, href, blocking, ...row }) => row)).toEqual(shared.items);
  });

  it('gives the sidebar the number the screen prints, and nothing when there is nothing', async () => {
    expect(await panelInboxCount(request(OWNER))).toBe(0);

    const task = await AgentTask.create({
      projectId: mine.id, externalId: 'local:1', title: 'Задача', status: 'running', priority: 'normal',
    } as any);
    await askQuestion(mine, task);

    const inbox = await panelInbox(request(OWNER));
    expect(await panelInboxCount(request(OWNER))).toBe(inbox.actionableCount);
  });

  it('counts a reminder without counting it as waiting', async () => {
    // A task stuck on a failure: shown, and deliberately not in `actionableCount` — nothing local
    // ever resolves it, so counting it would grow the number until it meant nothing.
    const task = await AgentTask.create({
      projectId: mine.id, externalId: 'local:2', title: 'Упала', status: 'failed', priority: 'normal',
    } as any);
    await AgentRun.create({
      projectId: mine.id, taskId: task.id, status: 'failed', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
      errorMessage: 'boom', finishedAt: new Date(),
    } as any);

    const inbox = await panelInbox(request(OWNER));
    expect(inbox.items.map((item) => item.kind)).toEqual(['run_failed']);
    expect(inbox.actionableCount).toBe(0);
    expect(inbox.reminderCount).toBe(1);
  });
});
