import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../../app-agentiz/models';
import { AgentActivity } from '../../app-agentiz/models/AgentActivity';
import { AgentApprovalRequest } from '../../app-agentiz/models/AgentApprovalRequest';
import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { AgentRun } from '../../app-agentiz/models/AgentRun';
import { AgentRunDiff } from '../../app-agentiz/models/AgentRunDiff';
import { AgentRunInteraction } from '../../app-agentiz/models/AgentRunInteraction';
import { AgentRunJob } from '../../app-agentiz/models/AgentRunJob';
import { AgentStageExecution } from '../../app-agentiz/models/AgentStageExecution';
import { AgentTask } from '../../app-agentiz/models/AgentTask';
import { AgentWorker } from '../../app-agentiz/models/AgentWorker';
import { AgentWorkerHarness } from '../../app-agentiz/models/AgentWorkerHarness';
import { AgentWorkspaceProposal } from '../../app-agentiz/models/AgentWorkspaceProposal';
import { MobileDevice } from '../models/MobileDevice';
import { MobileInboxDismissal } from '../models/MobileInboxDismissal';
import { MobileActivityService } from './MobileActivityService';

/**
 * **The mobile API's inbox answer must not change by one field.**
 *
 * The builder and the collecting half of this service move into `app-agentiz/lib/inbox/` so the
 * panel can show the same rows; the panel is a new reader, and a new reader is not a reason for
 * the app to receive anything different. Every other test here asserts a property of one row —
 * useful, but a property test passes happily while a neighbouring field quietly disappears. This
 * one freezes the **whole** answer of the three endpoints the inbox travels on
 * (`/activities/summary`, `/tasks/:id`, `/tasks/:taskId/runs/:runId`) against a fixture that holds
 * one of every kind at once, which is the only way an accidental omission has nowhere to hide.
 *
 * The snapshot was recorded **before** the move. Re-recording it to make a diff go away is the one
 * thing that must not happen here: a change in it is a change to a shipped app's contract, and the
 * app on somebody's phone is not redeployed with the server.
 *
 * Ids, timestamps and anything else that varies per run are replaced by stable stand-ins — the
 * point is the shape and the words, not which uuid sqlite handed out.
 */

const OWNER = 31;
const NOW = new Date('2026-09-01T10:00:00.000Z');

describe('mobile inbox contract', () => {
  let sequelize: Sequelize;
  let project: AgentProject;
  let task: AgentTask;
  let questionRun: AgentRun;

  beforeAll(async () => {
    sequelize = new Sequelize({
      dialect: 'sqlite', storage: ':memory:', logging: false,
      models: [...(Object.values(agentizModels) as any[]), MobileDevice, MobileInboxDismissal],
    });
  });

  afterAll(async () => sequelize.close());

  /**
   * One project holding a row of every kind at once. Deliberately all together rather than one
   * per test: ordering, `actionableCount` and the three legacy arrays are properties of the whole
   * answer, and a fixture with one row in it cannot see them.
   */
  beforeEach(async () => {
    delete process.env.AGENTIZ_NOTIFY_POLICY;
    await sequelize.sync({ force: true });

    project = await AgentProject.create({ name: 'Биллинг', slug: 'billing', ownerId: OWNER } as any);
    task = await AgentTask.create({
      projectId: project.id, externalId: 'local:1', title: 'Починить счётчик', status: 'running', priority: 'normal',
    } as any);

    // question — an agent parked on an elicitation
    questionRun = await AgentRun.create({
      projectId: project.id, taskId: task.id, status: 'waiting_input', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
    } as any);
    const job = await AgentRunJob.create({
      runId: questionRun.id, projectId: project.id, status: 'running', attempt: 1, snapshot: {},
    } as any);
    const stage = await AgentStageExecution.create({
      runId: questionRun.id, stageIndex: 0, role: 'implement', status: 'waiting_input',
    } as any);
    await AgentRunInteraction.create({
      projectId: project.id, runId: questionRun.id, jobId: job.id, attempt: 1, stageExecutionId: stage.id,
      kind: 'elicitation', source: 'codex', externalRequestId: 'req-1',
      message: 'Ставить ли зависимость?\nподробности ниже',
      requestedSchema: { type: 'object', properties: {} }, status: 'pending',
    } as any);

    // review — a proposal with a real diff behind it
    const reviewRun = await AgentRun.create({
      projectId: project.id, taskId: task.id, status: 'succeeded', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'commit' } },
    } as any);
    const diff = await AgentRunDiff.create({
      runId: reviewRun.id, projectId: project.id, baseSha: 'a'.repeat(40), treeSha: 'b'.repeat(40),
      patch: 'diff', patchSizeBytes: 4, patchSha256: 'c'.repeat(64),
      ops: [{ op: 'upsert', path: 'a', content: 'x', encoding: 'utf-8' }],
      stats: { files: 3, insertions: 48, deletions: 12 }, truncated: false, appliedAt: null, proposalId: 'p',
    } as any);
    await AgentWorkspaceProposal.create({
      projectId: project.id, taskId: task.id, workerId: 'w1', workspaceKey: 'billing', workspacePath: '/srv/billing',
      reservationKey: 'w1:billing', initialRunId: reviewRun.id, latestRunId: reviewRun.id, revision: 2,
      latestDiffId: diff.id, remote: 'origin', targetMode: 'new', targetBranch: 'agentiz/counter',
      commitMessage: 'Обновить зависимости\n\nподробно', status: 'waiting_review',
    } as any);

    // approval — a workflow's human gate
    const approvalRun = await AgentRun.create({
      projectId: project.id, taskId: task.id, status: 'succeeded', trigger: 'workflow', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
      verdict: 'pass', verdictReason: null, branch: 'agentiz/counter',
    } as any);
    await AgentApprovalRequest.create({
      projectId: project.id, taskId: task.id, runId: approvalRun.id, status: 'pending',
      workflowRunId: 'wf-1', nodeId: 'gate', assigneeToken: 'agentiz-approval-decide', assigneeUserId: null,
      title: 'Принять работу?', body: 'Проверьте счётчик на стенде',
    } as any);

    // harness_auth — the machine this run needs is logged out
    const worker = await AgentWorker.create({ name: 'worker-2', kind: 'external', status: 'active' } as any);
    await AgentWorkerHarness.create({
      workerId: worker.id, harnessKey: 'claude', authState: 'expired',
      authDetail: 'refresh token expired', authFailedSince: NOW,
    } as any);
    const blockedRun = await AgentRun.create({
      projectId: project.id, taskId: task.id, status: 'queued', trigger: 'manual', currentStageIndex: 0,
      waitingReason: 'harness_auth', pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
    } as any);
    await AgentRunJob.create({
      runId: blockedRun.id, projectId: project.id, status: 'queued', attempt: 0, harnessKey: 'claude',
      requiredWorkerId: worker.id, snapshot: {},
    } as any);

    // pr — a reminder, shown and deliberately not counted
    const prRun = await AgentRun.create({
      projectId: project.id, taskId: task.id, status: 'succeeded', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'pull_request' } },
    } as any);
    await AgentActivity.create({
      type: 'pr.opened', kind: 'action_required', projectId: project.id, title: 'Открыт pull request',
      body: 'https://git/pr/1', runId: prRun.id, taskId: task.id, proposalId: null, interactionId: null,
      data: { prUrl: 'https://git/pr/1' },
    } as any);
  });

  /** Ids, dates and counts that vary per run, swapped for stand-ins so the shape is what is frozen. */
  const stable = (value: unknown): unknown => JSON.parse(
    JSON.stringify(value, (key, raw) => {
      if (raw === null || raw === undefined) return raw;
      if (/^\d{4}-\d{2}-\d{2}T/.test(String(raw))) return '<date>';
      if (/Id$|^id$/.test(key) && typeof raw === 'string' && raw.length >= 8) return `<${key}>`;
      if (key === 'id' && typeof raw === 'string') return '<id>';
      return raw;
    }),
  );

  it('answers /activities/summary exactly as it did before the builder moved', async () => {
    const summary = await MobileActivityService.summary(OWNER, OWNER);
    // The row ids embed entity ids, so they are normalised like every other id.
    await expect(JSON.stringify(stable(summary), null, 2))
      .toMatchFileSnapshot('./__snapshots__/mobile-inbox-summary.json');
  });

  it('answers a task’s actionRequired exactly as it did before', async () => {
    const items = await MobileActivityService.itemsForTask(task, project, OWNER);
    await expect(JSON.stringify(stable(items), null, 2))
      .toMatchFileSnapshot('./__snapshots__/mobile-inbox-task.json');
  });

  it('answers a run’s actionRequired exactly as it did before', async () => {
    const items = await MobileActivityService.itemsForRun(questionRun, task, project, OWNER);
    await expect(JSON.stringify(stable(items), null, 2))
      .toMatchFileSnapshot('./__snapshots__/mobile-inbox-run.json');
  });

  it('counts only what holds something, whatever else is in the list', async () => {
    const summary = await MobileActivityService.summary(OWNER, OWNER);
    // Named separately from the snapshot because this is the number a person reads, and a
    // snapshot diff is easy to accept without noticing which line moved.
    expect(summary.items.map((item) => item.kind))
      .toEqual(['harness_auth', 'question', 'review', 'approval', 'pr']);
    expect(summary.actionableCount).toBe(4);
  });
});
