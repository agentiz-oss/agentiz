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
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../models';
import { AgentActivity } from '../models/AgentActivity';
import { AgentProject } from '../models/AgentProject';
import { AgentRun } from '../models/AgentRun';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentTask } from '../models/AgentTask';
import { AgentWorkspaceProposal } from '../models/AgentWorkspaceProposal';
import { AgentWorkerApiService } from './AgentWorkerApiService';

/**
 * The proposal-lifecycle activities, emitted from the worker-result handlers. The distinctions
 * that matter: auto-approve passes `waiting_review` only in transit and must announce nothing,
 * while `requireApproval` parks there for real and must; a pushed/failed action job tells the
 * owner what happened to the change they approved.
 */
describe('AgentWorkerApiService activity emits', () => {
  let sequelize: Sequelize;
  let run: AgentRun;
  let task: AgentTask;
  let proposal: AgentWorkspaceProposal;
  let job: AgentRunJob;

  beforeAll(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, models: Object.values(agentizModels) as any[] });
  });

  afterAll(async () => sequelize.close());

  async function setUp(finalAction: Record<string, unknown>) {
    await sequelize.sync({ force: true });
    const project = await AgentProject.create({ name: 'Owned', slug: 'owned', ownerId: 1 } as any);
    task = await AgentTask.create({ projectId: project.id, externalId: 'local:1', title: 'Fix auth', status: 'running', priority: 'normal' } as any);
    run = await AgentRun.create({
      projectId: project.id, taskId: task.id, status: 'running', trigger: 'manual', currentStageIndex: 0,
      workspaceRevision: 1,
      pipelineSnapshot: { stages: [], finalAction, source: { kind: 'worker_workspace' } },
    } as any);
    proposal = await AgentWorkspaceProposal.create({
      projectId: project.id, taskId: task.id, repositoryId: null, workerId: 'worker-1',
      workspaceKey: 'repo', workspacePath: '/srv/repo', reservationKey: 'worker-1:repo',
      initialRunId: run.id, latestRunId: run.id, revision: 1, latestDiffId: null,
      baseSha: null, baseBranch: null, remote: 'origin', remoteUrl: null,
      remoteBaseSha: null, expectedTreeSha: null, targetMode: 'new',
      targetBranch: 'agentiz/fix-auth', commitMessage: 'Fix auth', status: 'working',
    } as any);
    await run.update({ proposalId: proposal.id });
    job = await AgentRunJob.create({
      runId: run.id, projectId: project.id, jobKind: 'pipeline', proposalId: proposal.id,
      status: 'running', priority: 100, attempt: 1, snapshot: { proposal: { revision: 1 } },
    } as any);
  }

  const successPayload = () => ({
    schemaVersion: 1, attempt: 1, leaseToken: 't', resultId: 'r1',
    status: 'succeeded' as const,
    summary: 'сделано',
    fileOps: [{ op: 'upsert', path: 'a.txt', content: 'x', encoding: 'utf-8' }],
    patch: 'diff --git a b',
    treeSha: 'b'.repeat(40),
    baseSha: 'a'.repeat(40),
    git: { baseBranch: 'main', remote: 'origin', remoteUrl: 'git@github.com:acme/repo.git' },
  });

  it('announces proposal.waiting_review when requireApproval parks the change', async () => {
    await setUp({ type: 'commit', requireApproval: true, targetBranch: { mode: 'new' } });

    await (AgentWorkerApiService as any).applyWorkspacePipelineResult(job, run, task, successPayload(), 'сделано');

    expect((await proposal.reload()).status).toBe('waiting_review');
    const rows = await AgentActivity.findAll({ where: { type: 'proposal.waiting_review' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ proposalId: proposal.id, runId: run.id, taskId: task.id });
    expect(rows[0].data).toMatchObject({ revision: 1 });
    // The run itself finished too — deliberately a second record, collapsed by the push layer.
    expect(await AgentActivity.count({ where: { type: 'run.succeeded' } })).toBe(1);
  });

  it('stays silent about a review that auto-approve resolved in transit', async () => {
    await setUp({ type: 'commit', targetBranch: { mode: 'new' } });

    await (AgentWorkerApiService as any).applyWorkspacePipelineResult(job, run, task, successPayload(), 'сделано');

    expect((await proposal.reload()).status).toBe('apply_queued');
    expect(await AgentActivity.count({ where: { type: 'proposal.waiting_review' } })).toBe(0);
  });

  it('announces a failed run that still left something to review', async () => {
    await setUp({ type: 'commit', targetBranch: { mode: 'new' } });

    await (AgentWorkerApiService as any).applyWorkspacePipelineResult(job, run, task, {
      ...successPayload(), status: 'failed', errorMessage: 'последняя стадия упала',
    }, 'частично');

    expect((await proposal.reload()).status).toBe('waiting_review');
    expect(await AgentActivity.count({ where: { type: 'proposal.waiting_review' } })).toBe(1);
    expect(await AgentActivity.count({ where: { type: 'run.failed' } })).toBe(1);
  });

  it('announces proposal.pushed with the commit when the action job lands', async () => {
    await setUp({ type: 'commit', targetBranch: { mode: 'new' } });
    await proposal.update({ status: 'apply_queued' });
    const actionJob = await AgentRunJob.create({
      runId: run.id, projectId: run.projectId, jobKind: 'workspace_commit_push', proposalId: proposal.id,
      status: 'running', priority: 50, attempt: 1, snapshot: { proposal: { revision: 1 } },
    } as any);

    await (AgentWorkerApiService as any).applyWorkspaceActionResult(actionJob, {
      schemaVersion: 1, attempt: 1, leaseToken: 't', resultId: 'r2', status: 'succeeded', commitSha: 'd'.repeat(40),
    });

    const rows = await AgentActivity.findAll({ where: { type: 'proposal.pushed' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toMatchObject({ commitSha: 'd'.repeat(40) });
    expect(rows[0].body).toContain('dddddddddddd');
  });

  it('announces proposal.push_failed when the action job fails', async () => {
    await setUp({ type: 'commit', targetBranch: { mode: 'new' } });
    await proposal.update({ status: 'apply_queued' });
    const actionJob = await AgentRunJob.create({
      runId: run.id, projectId: run.projectId, jobKind: 'workspace_commit_push', proposalId: proposal.id,
      status: 'running', priority: 50, attempt: 1, snapshot: { proposal: { revision: 1 } },
    } as any);

    await (AgentWorkerApiService as any).applyWorkspaceActionResult(actionJob, {
      schemaVersion: 1, attempt: 1, leaseToken: 't', resultId: 'r3', status: 'failed', errorMessage: 'remote rejected',
    });

    const rows = await AgentActivity.findAll({ where: { type: 'proposal.push_failed' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toContain('remote rejected');
    expect((await proposal.reload()).status).toBe('push_failed');
  });

  it('announces proposal.reset_failed when the reset job fails', async () => {
    await setUp({ type: 'commit', targetBranch: { mode: 'new' } });
    await proposal.update({ status: 'reset_queued' });
    const actionJob = await AgentRunJob.create({
      runId: run.id, projectId: run.projectId, jobKind: 'workspace_reset', proposalId: proposal.id,
      status: 'running', priority: 50, attempt: 1, snapshot: { proposal: { revision: 1 } },
    } as any);

    await (AgentWorkerApiService as any).applyWorkspaceActionResult(actionJob, {
      schemaVersion: 1, attempt: 1, leaseToken: 't', resultId: 'r4', status: 'failed', errorMessage: 'dirty tree',
    });

    expect(await AgentActivity.count({ where: { type: 'proposal.reset_failed' } })).toBe(1);
    expect((await proposal.reload()).status).toBe('reset_failed');
  });
});
