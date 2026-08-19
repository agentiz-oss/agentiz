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
      models: [...(Object.values(agentizModels) as any[]), MobileDevice],
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
});
