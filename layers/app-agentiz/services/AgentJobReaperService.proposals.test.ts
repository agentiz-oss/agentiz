import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
  AbstractNotificationService: class {
    protected adminizer: any;
    constructor(adminizer: any) {
      this.adminizer = adminizer;
    }
  },
}));
// Both windows are read once at module load, so they have to be set before the import below. A
// negative value makes every proposal in the sweep "old enough" without sleeping or backdating rows.
vi.hoisted(() => {
  process.env.AGENTIZ_PROPOSAL_ACTION_TIMEOUT_MS = '-1000';
  process.env.AGENTIZ_PROPOSAL_STRANDED_GRACE_MS = '-1000';
});
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../models';
import { AgentActivity } from '../models/AgentActivity';
import { AgentProject } from '../models/AgentProject';
import { AgentRun } from '../models/AgentRun';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentTask } from '../models/AgentTask';
import { AgentWorkspaceProposal } from '../models/AgentWorkspaceProposal';
import { AgentJobReaperService } from './AgentJobReaperService';

/**
 * The recovery half of the sweep: a workspace reservation that nothing is working on any more.
 *
 * Both arms exist because the lease machinery cannot reach them — they are jobs no worker ever
 * claimed, so `attempt` never grows and the bury path never fires. Neither arm may release the
 * reservation itself: the worker's on-disk marker outlives the database row, and dropping the
 * reservation with the marker still there only trades one block for a less legible one.
 */
describe('AgentJobReaperService workspace recovery', () => {
  let sequelize: Sequelize;
  let run: AgentRun;
  let task: AgentTask;
  let proposal: AgentWorkspaceProposal;

  beforeAll(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, models: Object.values(agentizModels) as any[] });
  });

  afterAll(async () => sequelize.close());

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    const project = await AgentProject.create({ name: 'Test', slug: 'test', ownerId: 1 } as any);
    task = await AgentTask.create({ projectId: project.id, externalId: 'local:1', title: 'Fix auth', status: 'running', priority: 'normal' } as any);
    run = await AgentRun.create({
      projectId: project.id, taskId: task.id, status: 'cancelled', trigger: 'manual', currentStageIndex: 0,
      workspaceRevision: 1,
      pipelineSnapshot: { stages: [], finalAction: { type: 'commit' }, source: { kind: 'worker_workspace' } },
    } as any);
    proposal = await AgentWorkspaceProposal.create({
      projectId: project.id, taskId: task.id, repositoryId: null, workerId: 'worker-1',
      workspaceKey: 'repo', workspacePath: '/srv/repo', reservationKey: 'worker-1:repo',
      initialRunId: run.id, latestRunId: run.id, revision: 1, latestDiffId: null,
      baseSha: 'a'.repeat(40), baseBranch: 'main', remote: 'origin', remoteUrl: 'git@github.com:acme/repo.git',
      remoteBaseSha: null, expectedTreeSha: null, targetMode: 'current', targetBranch: null,
      commitMessage: 'Fix auth', status: 'working',
    } as any);
    await run.update({ proposalId: proposal.id });
  });

  it('queues a reset for a proposal whose run ended without deciding it', async () => {
    const swept = await AgentJobReaperService.sweepOnce();
    expect(swept.recoveredProposals).toBe(1);
    await proposal.reload();
    expect(proposal.status).toBe('reset_queued');
    expect(proposal.reservationKey).toBe('worker-1:repo');
    const reset = await AgentRunJob.findOne({ where: { proposalId: proposal.id, jobKind: 'workspace_reset' } });
    expect(reset).toMatchObject({ status: 'queued', requiredWorkerId: 'worker-1' });
  });

  it('leaves a proposal alone while its run is still queued or leased somewhere', async () => {
    await run.update({ status: 'running' });
    await AgentRunJob.create({
      runId: run.id, projectId: proposal.projectId, jobKind: 'pipeline', status: 'running',
      priority: 50, attempt: 1, workerId: 'worker-1', requiredWorkerId: 'worker-1',
      lockedUntil: new Date(Date.now() + 60_000), snapshot: {}, result: null, lastError: null,
    } as any);
    expect((await AgentJobReaperService.sweepOnce()).recoveredProposals).toBe(0);
    expect((await proposal.reload()).status).toBe('working');
  });

  it('reopens a decision whose action job no worker ever claimed', async () => {
    await proposal.update({ status: 'reset_queued' });
    const job = await AgentRunJob.create({
      runId: run.id, projectId: proposal.projectId, jobKind: 'workspace_reset', proposalId: proposal.id,
      status: 'queued', priority: 50, attempt: 0, workerId: null, requiredWorkerId: 'worker-1',
      snapshot: { proposal: { id: proposal.id, revision: 1 } }, result: null, lastError: null,
    } as any);

    expect((await AgentJobReaperService.sweepOnce()).recoveredProposals).toBe(1);
    await proposal.reload();
    // Not released — reopened, so the review UI and MCP have a decision to act on again.
    expect(proposal.status).toBe('reset_failed');
    expect(proposal.reservationKey).toBe('worker-1:repo');
    expect(proposal.lastError).toMatch(/No worker claimed/);
    // Cancelled, so a worker that comes back tomorrow cannot report against a moved-on proposal.
    expect((await job.reload()).status).toBe('cancelled');
    expect((await task.reload()).status).toBe('waiting_review');
    const activity = await AgentActivity.findOne({ where: { proposalId: proposal.id } });
    expect(activity).toMatchObject({ type: 'proposal.reset_failed' });
  });

  it('keeps its hands off an action job that is being retried through the lease path', async () => {
    await proposal.update({ status: 'apply_queued' });
    await AgentRunJob.create({
      runId: run.id, projectId: proposal.projectId, jobKind: 'workspace_commit_push', proposalId: proposal.id,
      status: 'queued', priority: 50, attempt: 2, workerId: null, requiredWorkerId: 'worker-1',
      snapshot: { proposal: { id: proposal.id, revision: 1 } }, result: null, lastError: 'Lease expired after attempt 2',
    } as any);
    expect((await AgentJobReaperService.sweepOnce()).recoveredProposals).toBe(0);
    expect((await proposal.reload()).status).toBe('apply_queued');
  });

  it('ignores a proposal that no longer holds its directory', async () => {
    await proposal.update({ status: 'working', reservationKey: null });
    expect((await AgentJobReaperService.sweepOnce()).recoveredProposals).toBe(0);
  });
});
