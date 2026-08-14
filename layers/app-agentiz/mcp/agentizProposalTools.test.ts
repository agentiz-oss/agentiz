import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../models';
import { AgentProject } from '../models/AgentProject';
import { AgentRun } from '../models/AgentRun';
import { AgentRunDiff } from '../models/AgentRunDiff';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentTask } from '../models/AgentTask';
import { AgentWorkspaceProposal } from '../models/AgentWorkspaceProposal';
import { agentizProposalMcpTools } from './agentizProposalTools';

const proposalsTool = agentizProposalMcpTools.find((tool) => tool.name === 'agentiz.proposals')!;
const manageTool = agentizProposalMcpTools.find((tool) => tool.name === 'agentiz.manageProposal')!;

/**
 * The tools exist for one situation: a run died without producing a change, its proposal kept the
 * worker directory, and nothing outside the dashboard could give it back.
 */
describe('agentiz proposal MCP tools', () => {
  let sequelize: Sequelize;
  let proposal: AgentWorkspaceProposal;
  let run: AgentRun;

  const call = async (tool: typeof proposalsTool, params: Record<string, unknown>): Promise<any> =>
    (tool.handler as (params: unknown) => Promise<unknown>)(params);

  beforeAll(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, models: Object.values(agentizModels) as any[] });
  });

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    const project = await AgentProject.create({ name: 'Test', slug: 'test', ownerId: 1 } as any);
    const task = await AgentTask.create({ projectId: project.id, externalId: 'local:1', title: 'Version', status: 'waiting_review', priority: 'normal' } as any);
    run = await AgentRun.create({
      projectId: project.id, taskId: task.id, status: 'failed', trigger: 'manual', currentStageIndex: 0,
      proposalId: null, workspaceRevision: 1,
      pipelineSnapshot: { stages: [], finalAction: { type: 'commit', targetBranch: { mode: 'new' } }, source: { kind: 'worker_workspace' } },
    } as any);
    proposal = await AgentWorkspaceProposal.create({
      projectId: project.id, taskId: task.id, repositoryId: null, workerId: 'worker-1',
      workspaceKey: '/srv/repo', workspacePath: '/srv/repo', reservationKey: 'worker-1:/srv/repo',
      initialRunId: run.id, latestRunId: run.id, revision: 1, latestDiffId: null,
      baseSha: 'a'.repeat(40), baseBranch: 'main', remote: 'origin', remoteUrl: 'git@github.com:acme/repo.git',
      remoteBaseSha: 'a'.repeat(40), expectedTreeSha: 'b'.repeat(40), targetMode: 'new',
      targetBranch: 'agentiz/version', commitMessage: 'Version', status: 'waiting_review',
      lastError: "Internal error: You've hit your session limit",
    } as any);
    await run.update({ proposalId: proposal.id });
    // What a run that failed before changing anything leaves behind: a revision with no operations.
    const diff = await AgentRunDiff.create({
      runId: run.id, projectId: project.id, repositoryId: null, proposalId: proposal.id, revision: 1,
      baseSha: proposal.baseSha, treeSha: proposal.expectedTreeSha, patch: null, patchSizeBytes: 0,
      patchSha256: 'e'.repeat(64), ops: [], stats: { files: 0, insertions: 0, deletions: 0 }, truncated: false,
    } as any);
    await proposal.update({ latestDiffId: diff.id });
  });

  afterAll(async () => sequelize.close());

  it('reports which proposal holds a directory and that it cannot be approved', async () => {
    const held = await call(proposalsTool, { holding: true });
    expect(held.count).toBe(1);
    expect(held.items[0]).toMatchObject({
      id: proposal.id,
      holdsWorkspace: true,
      workspacePath: '/srv/repo',
      reservationKey: 'worker-1:/srv/repo',
      approvable: false,
      reviewedChanges: { operations: 0, truncated: false },
    });
    expect(held.items[0].lastError).toMatch(/session limit/);
  });

  it('hides a proposal that no longer holds its directory', async () => {
    await proposal.update({ status: 'pushed', reservationKey: null });
    expect((await call(proposalsTool, { holding: true })).count).toBe(0);
    expect((await call(proposalsTool, { workspacePath: '/srv/repo' })).count).toBe(1);
  });

  it('rejects an empty proposal and queues the reset that frees the directory', async () => {
    const result = await call(manageTool, { action: 'reject', proposalId: proposal.id });
    expect(result.proposal.status).toBe('reset_queued');
    expect(result.queuedJob).toMatchObject({ jobKind: 'workspace_reset', status: 'queued', requiredWorkerId: 'worker-1' });
    expect(await AgentRunJob.count({ where: { proposalId: proposal.id, jobKind: 'workspace_reset' } })).toBe(1);
    // Released by the worker's result, not by the decision: the marker is still on disk until then.
    expect(result.proposal.holdsWorkspace).toBe(true);
  });

  it('refuses to approve a revision with nothing in it', async () => {
    await expect(call(manageTool, { action: 'approve', proposalId: proposal.id }))
      .rejects.toThrow(/complete reviewed diff/);
  });

  it('honours an explicit stale revision instead of acting on the current one', async () => {
    await expect(call(manageTool, { action: 'reject', proposalId: proposal.id, revision: 0 }))
      .rejects.toThrow(/stale/);
  });
});
