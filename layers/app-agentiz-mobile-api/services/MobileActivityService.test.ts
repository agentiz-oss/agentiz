import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../../app-agentiz/models';
import { AgentActivity } from '../../app-agentiz/models/AgentActivity';
import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { AgentRun } from '../../app-agentiz/models/AgentRun';
import { AgentRunDiff } from '../../app-agentiz/models/AgentRunDiff';
import { AgentRunInteraction } from '../../app-agentiz/models/AgentRunInteraction';
import { AgentRunJob } from '../../app-agentiz/models/AgentRunJob';
import { AgentStageExecution } from '../../app-agentiz/models/AgentStageExecution';
import { AgentTask } from '../../app-agentiz/models/AgentTask';
import { AgentWorkspaceProposal } from '../../app-agentiz/models/AgentWorkspaceProposal';
import { MobileDevice } from '../models/MobileDevice';
import { MobileInboxDismissal } from '../models/MobileInboxDismissal';
import { MobileActivityService } from './MobileActivityService';

const OWNER = 21;
const STRANGER = 22;

describe('MobileActivityService', () => {
  let sequelize: Sequelize;
  let ownProject: AgentProject;
  let foreignProject: AgentProject;
  let ownTask: AgentTask;

  beforeAll(async () => {
    sequelize = new Sequelize({
      dialect: 'sqlite', storage: ':memory:', logging: false,
      models: [...(Object.values(agentizModels) as any[]), MobileDevice, MobileInboxDismissal],
    });
  });

  afterAll(async () => sequelize.close());

  beforeEach(async () => {
    delete process.env.AGENTIZ_NOTIFY_POLICY;
    await sequelize.sync({ force: true });
    ownProject = await AgentProject.create({ name: 'Mine', slug: 'mine', ownerId: OWNER } as any);
    foreignProject = await AgentProject.create({ name: 'Theirs', slug: 'theirs', ownerId: STRANGER } as any);
    ownTask = await AgentTask.create({ projectId: ownProject.id, externalId: 'local:1', title: 'Моя задача', status: 'running', priority: 'normal' } as any);
  });

  const activity = (projectId: string, overrides: Record<string, unknown> = {}) => AgentActivity.create({
    type: 'run.failed', kind: 'info', projectId, title: 'Запуск завершился с ошибкой', body: 'boom',
    runId: null, taskId: null, proposalId: null, interactionId: null, data: null,
    ...overrides,
  } as any);

  it('shows only the caller’s projects, enriched with names', async () => {
    await activity(ownProject.id, { taskId: ownTask.id });
    await activity(foreignProject.id);

    const page = await MobileActivityService.list(OWNER);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      projectId: ownProject.id, projectName: 'Mine', taskTitle: 'Моя задача', type: 'run.failed',
    });
    expect(page.nextBefore).toBeNull();
    expect((await MobileActivityService.list(STRANGER)).items).toHaveLength(1);
    expect((await MobileActivityService.list(99)).items).toHaveLength(0);
  });

  it('pages newest-first through the before cursor without losing rows', async () => {
    for (let index = 0; index < 5; index += 1) {
      await activity(ownProject.id, { body: `row ${index}`, createdAt: new Date(Date.now() - index * 60_000) } as any);
    }

    const first = await MobileActivityService.list(OWNER, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextBefore).not.toBeNull();

    const second = await MobileActivityService.list(OWNER, { limit: 2, before: first.nextBefore });
    const third = await MobileActivityService.list(OWNER, { limit: 2, before: second.nextBefore });

    const seen = [...first.items, ...second.items, ...third.items].map((item) => item.body);
    expect(seen).toEqual(['row 0', 'row 1', 'row 2', 'row 3', 'row 4']);
    expect(third.nextBefore).toBeNull();
  });

  it('counts unseen from the per-user mark, which never moves backwards', async () => {
    await activity(ownProject.id);
    expect(await MobileActivityService.unseenCount(OWNER, OWNER)).toBe(1);

    await MobileActivityService.markSeen(OWNER);
    expect(await MobileActivityService.unseenCount(OWNER, OWNER)).toBe(0);

    // A stale client reporting an old timestamp must not resurrect the badge.
    await MobileActivityService.markSeen(OWNER, new Date(Date.now() - 3_600_000));
    expect(await MobileActivityService.unseenCount(OWNER, OWNER)).toBe(0);

    await activity(ownProject.id, { createdAt: new Date(Date.now() + 1000) } as any);
    expect(await MobileActivityService.unseenCount(OWNER, OWNER)).toBe(1);
    // The stranger's feed is untouched by any of it.
    await activity(foreignProject.id);
    expect(await MobileActivityService.unseenCount(STRANGER, STRANGER)).toBe(1);
  });

  it('builds the actionable summary from live entities, not from the feed', async () => {
    const run = await AgentRun.create({
      projectId: ownProject.id, taskId: ownTask.id, status: 'waiting_input', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
    } as any);
    const job = await AgentRunJob.create({ runId: run.id, projectId: ownProject.id, status: 'running', attempt: 1, snapshot: {} } as any);
    const stage = await AgentStageExecution.create({ runId: run.id, stageIndex: 0, role: 'implement', status: 'waiting_input' } as any);
    await AgentRunInteraction.create({
      projectId: ownProject.id, runId: run.id, jobId: job.id, attempt: 1, stageExecutionId: stage.id,
      kind: 'elicitation', source: 'codex', externalRequestId: 'req-1', message: 'Вопрос?',
      requestedSchema: { type: 'object', properties: {} }, status: 'pending',
    } as any);
    await AgentWorkspaceProposal.create({
      projectId: ownProject.id, taskId: ownTask.id, workerId: 'w1', workspaceKey: 'k', workspacePath: '/srv/k',
      reservationKey: 'w1:k', initialRunId: run.id, latestRunId: run.id, revision: 1,
      remote: 'origin', targetMode: 'new', targetBranch: 'agentiz/x', commitMessage: 'msg', status: 'waiting_review',
    } as any);
    const heldRun = await AgentRun.create({
      projectId: ownProject.id, taskId: ownTask.id, status: 'succeeded', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'commit', requireApproval: true } },
    } as any);
    await AgentRunDiff.create({
      runId: heldRun.id, projectId: ownProject.id, baseSha: 'a'.repeat(40), treeSha: 'b'.repeat(40),
      patch: 'diff', patchSizeBytes: 4, patchSha256: 'c'.repeat(64),
      ops: [{ op: 'upsert', path: 'a', content: 'x', encoding: 'utf-8' }],
      stats: { files: 1, insertions: 1, deletions: 0 }, truncated: false, appliedAt: null,
    } as any);
    // Applied diffs and foreign projects stay out.
    const appliedRun = await AgentRun.create({
      projectId: ownProject.id, taskId: ownTask.id, status: 'succeeded', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'commit', requireApproval: true } },
    } as any);
    await AgentRunDiff.create({
      runId: appliedRun.id, projectId: ownProject.id, patchSizeBytes: 1, patchSha256: 'd'.repeat(64),
      ops: [], stats: { files: 0, insertions: 0, deletions: 0 }, truncated: false,
      appliedAt: new Date(), appliedCommitSha: 'e'.repeat(40),
    } as any);

    const summary = await MobileActivityService.summary(OWNER, OWNER);

    expect(summary.interactions).toHaveLength(1);
    expect(summary.proposals).toHaveLength(1);
    expect(summary.heldRuns).toHaveLength(1);
    expect(summary.actionableCount).toBe(3);
    expect(summary.interactions[0]).toMatchObject({ taskTitle: 'Моя задача' });
    expect(summary.heldRuns[0]).toMatchObject({ runId: heldRun.id, operations: 1 });

    expect((await MobileActivityService.summary(99, 99)).actionableCount).toBe(0);
  });

  it('projects everything actionable into one inbox list, blocked-first and with decision facts', async () => {
    const run = await AgentRun.create({
      projectId: ownProject.id, taskId: ownTask.id, status: 'waiting_input', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
    } as any);
    const job = await AgentRunJob.create({ runId: run.id, projectId: ownProject.id, status: 'running', attempt: 1, snapshot: {} } as any);
    const stage = await AgentStageExecution.create({ runId: run.id, stageIndex: 0, role: 'implement', status: 'waiting_input' } as any);
    await AgentRunInteraction.create({
      projectId: ownProject.id, runId: run.id, jobId: job.id, attempt: 1, stageExecutionId: stage.id,
      kind: 'elicitation', source: 'codex', externalRequestId: 'req-1', message: 'Ставить ли зависимость?\nподробности',
      requestedSchema: { type: 'object', properties: {} }, status: 'pending',
    } as any);
    const diff = await AgentRunDiff.create({
      runId: run.id, projectId: ownProject.id, baseSha: 'a'.repeat(40), treeSha: 'b'.repeat(40),
      patch: 'diff', patchSizeBytes: 4, patchSha256: 'c'.repeat(64),
      ops: [{ op: 'upsert', path: 'a', content: 'x', encoding: 'utf-8' }],
      stats: { files: 3, insertions: 48, deletions: 12 }, truncated: false, appliedAt: null, proposalId: 'p',
    } as any);
    const proposal = await AgentWorkspaceProposal.create({
      projectId: ownProject.id, taskId: ownTask.id, workerId: 'w1', workspaceKey: 'k', workspacePath: '/srv/k',
      reservationKey: 'w1:k', initialRunId: run.id, latestRunId: run.id, revision: 2, latestDiffId: diff.id,
      remote: 'origin', targetMode: 'new', targetBranch: 'agentiz/x', commitMessage: 'Обновить зависимости\n\nподробно',
      status: 'waiting_review',
    } as any);

    const summary = await MobileActivityService.summary(OWNER, OWNER);

    // A parked agent outranks a change that is merely waiting to be looked at.
    expect(summary.items.map((item) => item.kind)).toEqual(['question', 'review']);
    const [question, review] = summary.items;
    expect(question).toMatchObject({
      badge: 'вопрос',
      headline: 'Ставить ли зависимость?',
      facts: 'Запуск на паузе · этап implement',
      taskTitle: 'Моя задача',
      projectName: 'Mine',
    });
    expect(question.actions.map((action) => action.key)).toEqual(['answer']);
    // The card states what would be committed, never the agent's prose.
    expect(review).toMatchObject({
      badge: 'ревью',
      headline: 'Обновить зависимости',
      facts: '3 файл(ов) · +48/−12 · ветка agentiz/x · ревизия 2',
      proposalId: proposal.id,
      revision: 2,
    });
    expect(review.actions.map((action) => action.key)).toEqual(['approve', 'reject']);
    // The old three arrays keep carrying the same facts for builds that parse them.
    expect(summary.interactions).toHaveLength(1);
    expect(summary.proposals).toHaveLength(1);

    // A task-scoped read of the same thing is what the task screen's strip shows.
    expect((await MobileActivityService.itemsForTask(ownTask, ownProject)).map((item) => item.kind))
      .toEqual(['question', 'review']);
  });

  it('keeps an opened pull request in the inbox until its task is closed', async () => {
    const run = await AgentRun.create({
      projectId: ownProject.id, taskId: ownTask.id, status: 'succeeded', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'pull_request' } },
    } as any);
    await activity(ownProject.id, {
      type: 'pr.opened', kind: 'action_required', title: 'Открыт pull request',
      body: 'https://git/pr/1', runId: run.id, taskId: ownTask.id, data: { prUrl: 'https://git/pr/1' },
    });

    const open = await MobileActivityService.summary(OWNER, OWNER);
    expect(open.items).toHaveLength(1);
    expect(open.items[0]).toMatchObject({ kind: 'pr', badge: 'pull request', url: 'https://git/pr/1' });
    // Shown, never counted — nothing here ever learns that a PR was dealt with.
    expect(open.actionableCount).toBe(0);

    // Closing the task is the only signal Agentiz gets that the PR was dealt with.
    await ownTask.update({ status: 'done' });
    expect((await MobileActivityService.summary(OWNER, OWNER)).items).toHaveLength(0);
  });

  it('drops muted projects from the badge but never from the summary', async () => {
    const run = await AgentRun.create({
      projectId: ownProject.id, taskId: ownTask.id, status: 'waiting_input', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
    } as any);
    const job = await AgentRunJob.create({ runId: run.id, projectId: ownProject.id, status: 'running', attempt: 1, snapshot: {} } as any);
    const stage = await AgentStageExecution.create({ runId: run.id, stageIndex: 0, role: 'implement', status: 'waiting_input' } as any);
    await AgentRunInteraction.create({
      projectId: ownProject.id, runId: run.id, jobId: job.id, attempt: 1, stageExecutionId: stage.id,
      kind: 'elicitation', source: 'codex', externalRequestId: 'req-1', message: 'Вопрос?',
      requestedSchema: { type: 'object', properties: {} }, status: 'pending',
    } as any);

    expect(await MobileActivityService.badgeCount(OWNER)).toBe(1);

    process.env.AGENTIZ_NOTIFY_POLICY = JSON.stringify({ projects: { [ownProject.id]: { 'interaction.created': { push: 'off' } } } });
    try {
      expect(await MobileActivityService.badgeCount(OWNER)).toBe(0);
      expect((await MobileActivityService.summary(OWNER, OWNER)).actionableCount).toBe(1);
    } finally {
      delete process.env.AGENTIZ_NOTIFY_POLICY;
    }
  });
  it('turns a review nobody can approve into an honest "освободить папку" row', async () => {
    // The shape a research run leaves behind: it finished, answered in text, touched no file. The
    // proposal is still waiting_review and still holding the worker's directory.
    const run = await AgentRun.create({
      projectId: ownProject.id, taskId: ownTask.id, status: 'succeeded', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'commit' } },
    } as any);
    const diff = await AgentRunDiff.create({
      runId: run.id, projectId: ownProject.id, baseSha: 'a'.repeat(40), treeSha: 'b'.repeat(40),
      patch: '', patchSizeBytes: 0, patchSha256: 'c'.repeat(64),
      ops: [], stats: { files: 0, insertions: 0, deletions: 0 }, truncated: false, appliedAt: null, proposalId: 'p',
    } as any);
    await AgentWorkspaceProposal.create({
      projectId: ownProject.id, taskId: ownTask.id, workerId: 'w1', workspaceKey: 'lyapka-rf', workspacePath: '/prj/lyapka-rf',
      reservationKey: 'w1:lyapka-rf', initialRunId: run.id, latestRunId: run.id, revision: 1, latestDiffId: diff.id,
      remote: 'origin', targetMode: 'new', targetBranch: 'agentiz/x', commitMessage: 'выполни',
      status: 'waiting_review',
    } as any);

    const [item] = (await MobileActivityService.summary(OWNER, OWNER)).items;

    expect(item).toMatchObject({ kind: 'no_changes', badge: 'без изменений', headline: 'Запуск ничего не изменил' });
    // No approve to press and no pretending otherwise; reading the answer comes first, and the
    // remaining decision is only about the directory.
    expect(item.actions.map((action) => action.key)).toEqual(['open_run', 'reject']);
    expect(item.actions.find((action) => action.key === 'reject')?.label).toBe('Освободить папку');
    expect(item.explain).toContain('lyapka-rf');
    // Ahead of an ordinary review: this one is blocking every later run in that directory.
    expect(item.priority).toBeLessThan(3);
  });

  it('offers a stuck task one retry row, and drops it when the task is closed', async () => {
    await ownTask.update({ status: 'failed' });
    await AgentRun.create({
      projectId: ownProject.id, taskId: ownTask.id, status: 'failed', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
      errorMessage: 'POST /jobs/149854be/result: HTTP 409: {"message":"Successful result is not allowed"}',
      finishedAt: new Date(),
    } as any);
    // An earlier attempt of the same task is history, not a second thing to decide.
    await AgentRun.create({
      projectId: ownProject.id, taskId: ownTask.id, status: 'failed', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
      errorMessage: 'older', finishedAt: new Date(Date.now() - 3_600_000), createdAt: new Date(Date.now() - 3_600_000),
    } as any);

    const items = (await MobileActivityService.summary(OWNER, OWNER)).items;
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('run_failed');
    // A reminder always carries its own exit: nothing else in Agentiz will ever close this row.
    expect(items[0].actions.map((action) => action.key)).toEqual(['rerun', 'open_run', 'dismiss']);
    // Recognised wording up top, the raw diagnostic line kept underneath it.
    expect(items[0].headline).toBe('Воркер не смог отчитаться серверу');
    expect(items[0].facts).toContain('HTTP 409');
    // A reminder, not a block: it is in the list but out of the number on the icon.
    expect((await MobileActivityService.summary(OWNER, OWNER)).actionableCount).toBe(0);
    // The same row is what the task screen prints.
    expect((await MobileActivityService.itemsForTask(ownTask, ownProject)).map((item) => item.kind)).toEqual(['run_failed']);

    await ownTask.update({ status: 'ignored' });
    expect((await MobileActivityService.summary(OWNER, OWNER)).items).toHaveLength(0);
  });

  it('lets a reader close a reminder by reading it, and never a row that holds something', async () => {
    await ownTask.update({ status: 'failed' });
    const run = await AgentRun.create({
      projectId: ownProject.id, taskId: ownTask.id, status: 'failed', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
      errorMessage: 'POST /jobs/1/result: HTTP 409: nope', finishedAt: new Date(),
    } as any);

    const before = await MobileActivityService.summary(OWNER, OWNER);
    expect(before.items.map((item) => item.id)).toEqual([`run:${run.id}`]);
    expect(before.dismissedCount).toBe(0);

    await MobileActivityService.dismiss(OWNER, OWNER, `run:${run.id}`);

    const after = await MobileActivityService.summary(OWNER, OWNER);
    expect(after.items).toHaveLength(0);
    expect(after.dismissedCount).toBe(1);
    // Hidden from the inbox is hidden everywhere: the task's own screen must agree with it.
    expect(await MobileActivityService.itemsForTask(ownTask, ownProject, OWNER)).toHaveLength(0);
    // Nothing was decided *about the task* — only about the reader's list.
    await ownTask.reload();
    expect(ownTask.status).toBe('failed');

    // Asked for explicitly, it comes back last, marked, and offering the undo.
    const shown = await MobileActivityService.summary(OWNER, OWNER, { includeDismissed: true });
    expect(shown.items).toHaveLength(1);
    expect(shown.items[0].dismissedAt).toBeTruthy();
    expect(shown.items[0].actions.map((action) => action.key)).toContain('restore');

    await MobileActivityService.restore(OWNER, OWNER, `run:${run.id}`);
    expect((await MobileActivityService.summary(OWNER, OWNER)).items).toHaveLength(1);

    // A run that fails again is a different row, so a dismissal can never hide a future failure.
    await MobileActivityService.dismiss(OWNER, OWNER, `run:${run.id}`);
    const second = await AgentRun.create({
      projectId: ownProject.id, taskId: ownTask.id, status: 'failed', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
      errorMessage: 'and again', finishedAt: new Date(Date.now() + 1000), createdAt: new Date(Date.now() + 1000),
    } as any);
    expect((await MobileActivityService.summary(OWNER, OWNER)).items.map((item) => item.id))
      .toEqual([`run:${second.id}`]);
  });

  it('refuses to hide a row that holds a worker’s directory', async () => {
    const run = await AgentRun.create({
      projectId: ownProject.id, taskId: ownTask.id, status: 'succeeded', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
    } as any);
    const proposal = await AgentWorkspaceProposal.create({
      projectId: ownProject.id, taskId: ownTask.id, workerId: 'w1', workspaceKey: 'k', workspacePath: '/srv/k',
      reservationKey: 'w1:k', initialRunId: run.id, latestRunId: run.id, revision: 1,
      remote: 'origin', targetMode: 'new', targetBranch: 'agentiz/x', commitMessage: 'msg', status: 'waiting_review',
    } as any);

    const items = (await MobileActivityService.summary(OWNER, OWNER)).items;
    expect(items[0].dismissible).toBe(false);
    await expect(MobileActivityService.dismiss(OWNER, OWNER, `proposal:${proposal.id}`)).rejects.toMatchObject({ status: 409 });
    // And a row belonging to somebody else is not there to be hidden at all.
    await expect(MobileActivityService.dismiss(STRANGER, STRANGER, `proposal:${proposal.id}`)).rejects.toMatchObject({ status: 404 });
  });

  it('tells each row how its own notification is configured, and which rule decided', async () => {
    await ownTask.update({ status: 'failed' });
    await AgentRun.create({
      projectId: ownProject.id, taskId: ownTask.id, status: 'failed', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'none' } }, errorMessage: 'boom', finishedAt: new Date(),
    } as any);

    const builtin = (await MobileActivityService.summary(OWNER, OWNER)).items[0].notify;
    expect(builtin).toMatchObject({ push: 'on', scope: 'builtin', mutedByScope: false });
    expect(builtin.label).toBe('пуш включён по умолчанию');

    // Muting the project must show up on the row as the project's doing, not as a default.
    process.env.AGENTIZ_NOTIFY_POLICY = JSON.stringify({ projects: { [ownProject.id]: { mute: true } } });
    try {
      const muted = (await MobileActivityService.summary(OWNER, OWNER)).items[0].notify;
      expect(muted).toMatchObject({ push: 'off', scope: 'project', mutedByScope: true });
      expect(muted.label).toBe('пуш выключен правилом проекта');
    } finally {
      delete process.env.AGENTIZ_NOTIFY_POLICY;
    }
  });

  it('answers what one run is waiting on, so its screen can say it above the result', async () => {
    const run = await AgentRun.create({
      projectId: ownProject.id, taskId: ownTask.id, status: 'waiting_input', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
    } as any);
    const other = await AgentRun.create({
      projectId: ownProject.id, taskId: ownTask.id, status: 'waiting_input', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
    } as any);
    const job = await AgentRunJob.create({ runId: run.id, projectId: ownProject.id, status: 'running', attempt: 1, snapshot: {} } as any);
    for (const [target, message] of [[run, 'Ставить ли зависимость?'], [other, 'Чужой вопрос']] as const) {
      const stage = await AgentStageExecution.create({
        runId: (target as AgentRun).id, stageIndex: 0, role: 'implement', status: 'waiting_input',
      } as any);
      await AgentRunInteraction.create({
        projectId: ownProject.id, runId: (target as AgentRun).id, jobId: job.id, attempt: 1, stageExecutionId: stage.id,
        kind: 'elicitation', source: 'codex', externalRequestId: `req-${(target as AgentRun).id}`, message,
        requestedSchema: { type: 'object', properties: {} }, status: 'pending',
      } as any);
    }

    const items = await MobileActivityService.itemsForRun(run, ownTask, ownProject);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'question', headline: 'Ставить ли зависимость?', runId: run.id });
    expect(items[0].explain).toBeTruthy();
  });
  it('sinks reminders as newer ones arrive, while blocking rows still climb by age', async () => {
    // No expiry rule anywhere: old reminders leave the top of the list because newer ones push
    // them down, which is the whole mechanism behind "уйдут вниз и перестанут попадаться на глаза".
    const older = await AgentTask.create({ projectId: ownProject.id, externalId: 'local:old', title: 'Старая', status: 'failed', priority: 'normal' } as any);
    const newer = await AgentTask.create({ projectId: ownProject.id, externalId: 'local:new', title: 'Свежая', status: 'failed', priority: 'normal' } as any);
    for (const [task, when] of [[older, 30], [newer, 1]] as const) {
      await AgentRun.create({
        projectId: ownProject.id, taskId: (task as AgentTask).id, status: 'failed', trigger: 'manual', currentStageIndex: 0,
        pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
        errorMessage: 'boom', finishedAt: new Date(Date.now() - (when as number) * 86_400_000),
      } as any);
    }

    const items = (await MobileActivityService.summary(OWNER, OWNER)).items;

    expect(items.map((item) => item.taskTitle)).toEqual(['Свежая', 'Старая']);
    expect((await MobileActivityService.summary(OWNER, OWNER)).actionableCount).toBe(0);
  });
});
