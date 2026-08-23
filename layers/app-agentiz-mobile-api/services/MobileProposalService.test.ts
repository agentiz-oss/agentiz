import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../../app-agentiz/models';
import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { AgentRun } from '../../app-agentiz/models/AgentRun';
import { AgentRunDiff } from '../../app-agentiz/models/AgentRunDiff';
import { AgentRunJob } from '../../app-agentiz/models/AgentRunJob';
import { AgentTask } from '../../app-agentiz/models/AgentTask';
import { AgentWorkspaceProposal } from '../../app-agentiz/models/AgentWorkspaceProposal';
import { MobileDevice } from '../models/MobileDevice';
import { MobileInboxDismissal } from '../models/MobileInboxDismissal';
import { MobileProposalService } from './MobileProposalService';

const OWNER = 21;
const STRANGER = 22;

/**
 * Approve/reject from the phone. What matters: the ownership wall (a foreign proposal is a 404
 * that confirms nothing), and that the core service's 409s — stale revision, wrong status — reach
 * the client as 409s it can act on, not as flattened 500s.
 */
describe('MobileProposalService', () => {
  let sequelize: Sequelize;
  let proposal: AgentWorkspaceProposal;

  beforeAll(async () => {
    sequelize = new Sequelize({
      dialect: 'sqlite', storage: ':memory:', logging: false,
      models: [...(Object.values(agentizModels) as any[]), MobileDevice, MobileInboxDismissal],
    });
  });

  afterAll(async () => sequelize.close());

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    const project = await AgentProject.create({ name: 'Mine', slug: 'mine', ownerId: OWNER } as any);
    const task = await AgentTask.create({ projectId: project.id, externalId: 'local:1', title: 'Fix auth', status: 'waiting_review', priority: 'normal' } as any);
    const run = await AgentRun.create({
      projectId: project.id, taskId: task.id, status: 'succeeded', trigger: 'manual', currentStageIndex: 0, workspaceRevision: 1,
      pipelineSnapshot: { stages: [], finalAction: { type: 'commit', targetBranch: { mode: 'new' } }, source: { kind: 'worker_workspace' } },
    } as any);
    proposal = await AgentWorkspaceProposal.create({
      projectId: project.id, taskId: task.id, repositoryId: null, workerId: 'worker-1',
      workspaceKey: 'repo', workspacePath: '/srv/repo', reservationKey: 'worker-1:repo',
      initialRunId: run.id, latestRunId: run.id, revision: 1, latestDiffId: null,
      baseSha: 'a'.repeat(40), baseBranch: 'main', remote: 'origin', remoteUrl: 'git@github.com:acme/repo.git',
      remoteBaseSha: 'a'.repeat(40), expectedTreeSha: 'b'.repeat(40), targetMode: 'new',
      targetBranch: 'agentiz/fix-auth', commitMessage: 'Fix auth', status: 'waiting_review',
    } as any);
    await run.update({ proposalId: proposal.id });
    const diff = await AgentRunDiff.create({
      runId: run.id, projectId: project.id, proposalId: proposal.id, revision: 1,
      baseSha: proposal.baseSha, treeSha: proposal.expectedTreeSha, patch: 'diff', patchSizeBytes: 4,
      patchSha256: 'c'.repeat(64), ops: [{ op: 'upsert', path: 'a', content: 'x', encoding: 'utf-8' }],
      stats: { files: 1, insertions: 1, deletions: 0 }, truncated: false,
    } as any);
    await proposal.update({ latestDiffId: diff.id });
  });

  it('lists only the owner’s actionable proposals, with the approvable verdict', async () => {
    const rows = await MobileProposalService.list(OWNER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: proposal.id, status: 'waiting_review', approvable: true, holding: true, taskTitle: 'Fix auth',
    });
    expect((rows[0] as any).diff).toMatchObject({ operations: 1, truncated: false });

    expect(await MobileProposalService.list(STRANGER)).toHaveLength(0);
  });

  it('hides a foreign proposal behind a 404 for reads and writes alike', async () => {
    await expect(MobileProposalService.approve(proposal.id, STRANGER, { revision: 1 }, { id: STRANGER, name: 'sneaky' }))
      .rejects.toMatchObject({ status: 404 });
    await expect(MobileProposalService.reject(proposal.id, STRANGER, { revision: 1 }, { id: STRANGER, name: 'sneaky' }))
      .rejects.toMatchObject({ status: 404 });
    expect((await proposal.reload()).status).toBe('waiting_review');
  });

  it('approves through the core service and records the mobile actor', async () => {
    const result = await MobileProposalService.approve(
      proposal.id, OWNER, { revision: 1, commitMessage: 'Fix auth, reviewed' }, { id: OWNER, name: 'ivan' },
    );

    expect(result).toMatchObject({ status: 'apply_queued' });
    expect((await proposal.reload()).decisionActor).toBe(`user:${OWNER} (ivan)`);
    expect((await proposal.reload()).commitMessage).toBe('Fix auth, reviewed');
    expect(await AgentRunJob.count({ where: { proposalId: proposal.id, jobKind: 'workspace_commit_push' } })).toBe(1);
  });

  it('passes the core service’s 409 through untouched', async () => {
    await expect(MobileProposalService.approve(proposal.id, OWNER, { revision: 7 }, { id: OWNER, name: 'ivan' }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('stale') });

    await proposal.update({ status: 'pushed' });
    await expect(MobileProposalService.reject(proposal.id, OWNER, { revision: 1 }, { id: OWNER, name: 'ivan' }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('rejects into a queued workspace reset', async () => {
    const result = await MobileProposalService.reject(proposal.id, OWNER, { revision: 1 }, { id: OWNER, name: 'ivan' });
    expect(result).toMatchObject({ status: 'reset_queued' });
    expect(await AgentRunJob.count({ where: { proposalId: proposal.id, jobKind: 'workspace_reset' } })).toBe(1);
  });
});
