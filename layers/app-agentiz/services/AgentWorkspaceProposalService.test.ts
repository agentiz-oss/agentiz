import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../models';
import { AgentGitConnection } from '../models/AgentGitConnection';
import { AgentProject } from '../models/AgentProject';
import { AgentRepository } from '../models/AgentRepository';
import { AgentRun } from '../models/AgentRun';
import { AgentRunDiff } from '../models/AgentRunDiff';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentTask } from '../models/AgentTask';
import { AgentWorkspaceProposal } from '../models/AgentWorkspaceProposal';
import { AgentWorkspaceProposalService } from './AgentWorkspaceProposalService';
import { AgentPipelineService } from './AgentPipelineService';

describe('AgentWorkspaceProposalService', () => {
  let sequelize: Sequelize;
  let proposal: AgentWorkspaceProposal;

  beforeAll(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, models: Object.values(agentizModels) as any[] });
  });

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    const project = await AgentProject.create({ name: 'Test', slug: 'test', ownerId: 1 } as any);
    const task = await AgentTask.create({ projectId: project.id, externalId: 'local:1', title: 'Fix auth', status: 'waiting_review', priority: 'normal' } as any);
    const connection = await AgentGitConnection.create({ provider: 'github', status: 'active' } as any);
    const repository = await AgentRepository.create({
      connectionId: connection.id, provider: 'github', externalRepoId: '1', pathWithNamespace: 'acme/repo',
      owner: 'acme', repo: 'repo', cloneUrl: 'git@github.com:acme/repo.git', issuesEnabled: true,
    } as any);
    const run = await AgentRun.create({
      projectId: project.id, taskId: task.id, status: 'succeeded', trigger: 'manual', currentStageIndex: 0,
      proposalId: null, workspaceRevision: 1,
      pipelineSnapshot: { stages: [], finalAction: { type: 'commit', targetBranch: { mode: 'new' } }, source: { kind: 'worker_workspace' } },
    } as any);
    proposal = await AgentWorkspaceProposal.create({
      projectId: project.id, taskId: task.id, repositoryId: repository.id, workerId: 'worker-1',
      workspaceKey: 'repo', workspacePath: '/srv/repo', reservationKey: 'worker-1:repo',
      initialRunId: run.id, latestRunId: run.id, revision: 1, latestDiffId: null,
      baseSha: 'a'.repeat(40), baseBranch: 'main', remote: 'origin', remoteUrl: 'git@github.com:acme/repo.git',
      remoteBaseSha: 'a'.repeat(40), expectedTreeSha: 'b'.repeat(40), targetMode: 'new',
      targetBranch: 'agentiz/fix-auth7ac1', commitMessage: 'Fix authentication correctly', status: 'waiting_review',
    } as any);
    await run.update({ proposalId: proposal.id });
    const diff = await AgentRunDiff.create({
      runId: run.id, projectId: project.id, repositoryId: repository.id, proposalId: proposal.id, revision: 1,
      baseSha: proposal.baseSha, treeSha: proposal.expectedTreeSha, patch: 'diff', patchSizeBytes: 4,
      patchSha256: 'c'.repeat(64), ops: [{ op: 'upsert', path: 'a', content: 'x', encoding: 'utf-8' }],
      stats: { files: 1, insertions: 1, deletions: 0 }, truncated: false,
    } as any);
    await proposal.update({ latestDiffId: diff.id });
  });

  afterAll(async () => sequelize.close());

  it('queues exactly one pinned push job under an optimistic revision check', async () => {
    const approved = await AgentWorkspaceProposalService.approve(proposal.id, 1, 'reviewer');
    expect(approved.status).toBe('apply_queued');
    const jobs = await AgentRunJob.findAll({ where: { proposalId: proposal.id } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ jobKind: 'workspace_commit_push', requiredWorkerId: 'worker-1' });
    await expect(AgentWorkspaceProposalService.approve(proposal.id, 1, 'reviewer')).rejects.toMatchObject({ statusCode: 409 });
    expect(await AgentRunJob.count({ where: { proposalId: proposal.id } })).toBe(1);
  });

  it('blocks a stale or incomplete review and queues reset without releasing reservation', async () => {
    await expect(AgentWorkspaceProposalService.reject(proposal.id, 0, 'reviewer')).rejects.toMatchObject({ statusCode: 409 });
    const rejected = await AgentWorkspaceProposalService.reject(proposal.id, 1, 'reviewer');
    expect(rejected.status).toBe('reset_queued');
    expect(rejected.reservationKey).toBe('worker-1:repo');
    expect(await AgentRunJob.count({ where: { proposalId: proposal.id, jobKind: 'workspace_reset' } })).toBe(1);
  });

  it('queues a reset and keeps the reservation when a marked workspace fails without a reviewable diff', async () => {
    await proposal.update({ status: 'working', latestDiffId: null });
    const cleanedUp = await AgentWorkspaceProposalService.resetAfterUnreviewableFailure(proposal, 'OAuth session expired');
    expect(cleanedUp).toMatchObject({ status: 'reset_queued', reservationKey: 'worker-1:repo', lastError: 'OAuth session expired' });
    const reset = await AgentRunJob.findOne({ where: { proposalId: proposal.id, jobKind: 'workspace_reset' } });
    expect(reset).toMatchObject({ status: 'queued', requiredWorkerId: 'worker-1' });
  });

  // A worker directory pushes through its own remote, so there may be no AgentRepository at all; the
  // job then carries `repository: null` and the worker records the remote instead of verifying it.
  it('queues a push for a directory that pins no repository', async () => {
    await proposal.update({ repositoryId: null });
    const approved = await AgentWorkspaceProposalService.approve(proposal.id, 1, 'reviewer');
    expect(approved.status).toBe('apply_queued');
    const job = await AgentRunJob.findOne({ where: { proposalId: proposal.id, jobKind: 'workspace_commit_push' } });
    expect(job).toBeTruthy();
    expect(job!.repositoryId).toBeNull();
    expect((job!.snapshot as any).repository).toBeNull();
    expect((job!.snapshot as any).proposal.remote).toBe('origin');
  });

  it('never approves a truncated patch', async () => {
    await AgentRunDiff.update({ truncated: true }, { where: { proposalId: proposal.id } });
    await expect(AgentWorkspaceProposalService.approve(proposal.id, 1, 'reviewer')).rejects.toThrow(/complete reviewed diff/);
  });

  /**
   * `release` exists for the statuses `reject` answers with a 409 while the directory stays
   * reserved — the state a cancelled run or a dead worker leaves behind.
   */
  describe('release', () => {
    it('frees a directory stranded in a status reject refuses', async () => {
      await proposal.update({ status: 'working' });
      await AgentRunJob.create({
        runId: proposal.latestRunId, projectId: proposal.projectId, jobKind: 'pipeline', proposalId: null,
        status: 'queued', priority: 50, attempt: 0, workerId: null, requiredWorkerId: 'worker-1',
        snapshot: {}, result: null, lastError: null,
      } as any);
      await expect(AgentWorkspaceProposalService.reject(proposal.id, 1, 'ops')).rejects.toMatchObject({ statusCode: 409 });

      const outcome = await AgentWorkspaceProposalService.release(proposal.id, 'ops');
      expect(outcome.released).toBe(false);
      expect(outcome.proposal.status).toBe('reset_queued');
      // Still reserved: only the worker's own report may drop it, once the marker is gone.
      expect(outcome.proposal.reservationKey).toBe('worker-1:repo');
      const reset = await AgentRunJob.findOne({ where: { proposalId: proposal.id, jobKind: 'workspace_reset' } });
      expect(reset).toMatchObject({ status: 'queued', requiredWorkerId: 'worker-1' });
      // The abandoned pipeline job is out of the queue, so it cannot wake up and report later.
      const stranded = await AgentRunJob.findOne({ where: { jobKind: 'pipeline' } });
      expect(stranded!.status).toBe('cancelled');
    });

    it('drops the reservation without a worker only when forced, and says the directory was not restored', async () => {
      await proposal.update({ status: 'reset_failed', lastError: 'worker offline' });
      const outcome = await AgentWorkspaceProposalService.release(proposal.id, 'ops', { force: true });
      expect(outcome.released).toBe(true);
      expect(outcome.proposal.status).toBe('rejected');
      expect(outcome.proposal.reservationKey).toBeNull();
      expect(outcome.proposal.lastError).toMatch(/forced/);
      // The one case where no sha will ever come back, so the *name* has to be on the record.
      expect(outcome.proposal.lastError).toContain(`agentiz: proposal ${proposal.id} revision 1`);
      expect(await AgentRunJob.count({ where: { proposalId: proposal.id } })).toBe(0);
    });

    it('refuses a safe release while a worker still holds the lease, and asks that job to stop', async () => {
      await proposal.update({ status: 'working' });
      const job = await AgentRunJob.create({
        runId: proposal.latestRunId, projectId: proposal.projectId, jobKind: 'pipeline', proposalId: null,
        status: 'running', priority: 50, attempt: 1, workerId: 'worker-1', requiredWorkerId: 'worker-1',
        lockedUntil: new Date(Date.now() + 60_000), snapshot: {}, result: null, lastError: null,
      } as any);
      await expect(AgentWorkspaceProposalService.release(proposal.id, 'ops')).rejects.toMatchObject({ statusCode: 409 });
      // Refusing without asking would make the suggested retry pointless: nothing would ever stop.
      expect((await job.reload()).cancelRequestedAt).toBeTruthy();

      // Forcing past a live lease is allowed — that is what "the worker is gone" looks like when it
      // is wrong about being alive — and the job is asked to stop either way.
      const forced = await AgentWorkspaceProposalService.release(proposal.id, 'ops', { force: true });
      expect(forced.proposal.reservationKey).toBeNull();
      expect((await job.reload()).cancelRequestedAt).toBeTruthy();
    });

    it('settles the workspace when the run holding it is cancelled', async () => {
      const run = await AgentRun.findByPk(proposal.latestRunId);
      await run!.update({ status: 'running' });
      await proposal.update({ status: 'working' });
      await AgentRunJob.create({
        runId: run!.id, projectId: proposal.projectId, jobKind: 'pipeline', status: 'queued',
        priority: 50, attempt: 0, requiredWorkerId: 'worker-1', snapshot: {}, result: null, lastError: null,
      } as any);

      await AgentPipelineService.cancelRun(run!.id, 'Cancelled by user');

      // Answering the cancel as a reject is only safe because the reset stashes: the agent's work
      // survives on the worker, so nothing the person cancelling might have wanted is spent.
      await proposal.reload();
      expect(proposal.status).toBe('reset_queued');
      expect(await AgentRunJob.count({ where: { proposalId: proposal.id, jobKind: 'workspace_reset' } })).toBe(1);
    });

    it('leaves the workspace to the worker when the cancelled run is still executing', async () => {
      const run = await AgentRun.findByPk(proposal.latestRunId);
      await run!.update({ status: 'running' });
      await proposal.update({ status: 'working' });
      await AgentRunJob.create({
        runId: run!.id, projectId: proposal.projectId, jobKind: 'pipeline', status: 'running',
        priority: 50, attempt: 1, workerId: 'worker-1', requiredWorkerId: 'worker-1',
        lockedUntil: new Date(Date.now() + 60_000), snapshot: {}, result: null, lastError: null,
      } as any);

      await AgentPipelineService.cancelRun(run!.id, 'Cancelled by user');

      // Only the worker can clear its on-disk marker, and it is about to report anyway.
      expect((await proposal.reload()).status).toBe('working');
      expect(await AgentRunJob.count({ where: { jobKind: 'workspace_reset' } })).toBe(0);
    });

    it('is idempotent once nothing holds the directory', async () => {
      await proposal.update({ status: 'pushed', reservationKey: null });
      const outcome = await AgentWorkspaceProposalService.release(proposal.id, 'ops');
      expect(outcome).toMatchObject({ released: true, queuedJobId: null });
      expect(outcome.proposal.status).toBe('pushed');
    });
  });
});
