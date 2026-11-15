import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
  AbstractNotificationService: class {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../models';
import { AgentActivity } from '../models/AgentActivity';
import { AgentGitConnection } from '../models/AgentGitConnection';
import { AgentProject } from '../models/AgentProject';
import { AgentProjectRepository } from '../models/AgentProjectRepository';
import { AgentRepository } from '../models/AgentRepository';
import { AgentRun } from '../models/AgentRun';
import { AgentRunDiff } from '../models/AgentRunDiff';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentRunLog } from '../models/AgentRunLog';
import { AgentTask } from '../models/AgentTask';
import { AgentWorkspaceProposal } from '../models/AgentWorkspaceProposal';
import { AgentWorkerApiService } from './AgentWorkerApiService';
import { AgentWorkspaceProposalService } from './AgentWorkspaceProposalService';
import { RepositoryResolverService } from './RepositoryResolverService';
import { assertValidSpec } from './PipelineSpecValidation';
import { workspacePullRequestBody } from './AgentPipelineService';

/**
 * `finalAction.openPullRequest` on a worker directory: the PR is opened by the server once the
 * worker reported the branch pushed — and a spec that does not name the field must come out of
 * the push exactly as it did before the field existed (AGENTS.md: extending a spec proves old
 * pipelines keep working). The legacy case is therefore the first test, with the field *absent*,
 * not `false`.
 */

/** The shape of the production «Develop» pipeline before this field existed. */
function legacySpec(repositoryId: string): Record<string, unknown> {
  return {
    source: { kind: 'worker_workspace', workspace: { path: '/srv/repo', workerId: 'worker-1' }, repositoryId },
    stages: [{ role: 'implement', order: 1, runtime: { mode: 'host' }, agentRoleKey: 'developer' }],
    finalAction: { type: 'commit', targetBranch: { mode: 'new', prefix: 'agentiz/' }, commitMessageTemplate: '{{title}}' },
  };
}

describe('pull request from a worker directory', () => {
  let sequelize: Sequelize;
  let proposal: AgentWorkspaceProposal;
  let run: AgentRun;
  let task: AgentTask;
  let repository: AgentRepository;
  const openPullRequest = vi.fn();

  beforeAll(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, models: Object.values(agentizModels) as any[] });
  });
  afterAll(async () => sequelize.close());
  afterEach(() => vi.restoreAllMocks());

  async function setUp(finalAction: Record<string, unknown>, rawMarkerRepositoryId?: string): Promise<void> {
    const project = await AgentProject.create({ name: 'Promo', slug: 'promo', ownerId: 1 } as any);
    const connection = await AgentGitConnection.create({ provider: 'github', status: 'active' } as any);
    repository = await AgentRepository.create({
      connectionId: connection.id, provider: 'github', externalRepoId: '1', pathWithNamespace: 'webresto/promo',
      owner: 'webresto', repo: 'promo', cloneUrl: 'https://github.com/webresto/promo.git', issuesEnabled: true,
    } as any);
    await AgentProjectRepository.create({
      projectId: project.id, repositoryId: repository.id, connectionId: connection.id, provider: 'github',
      role: 'both', isPrimary: true, syncIssues: true, isActive: true,
    } as any);
    task = await AgentTask.create({
      projectId: project.id, externalId: 'gh-1-7', title: 'Landing page', status: 'waiting_review', priority: 'normal',
      // 'own' = an issue of the very repository the PR is opened in.
      raw: rawMarkerRepositoryId
        ? { agentizIntegration: { provider: 'github', integrationId: 'link', connectionId: connection.id, repositoryId: rawMarkerRepositoryId === 'own' ? repository.id : rawMarkerRepositoryId, issueNumber: 7 } }
        : null,
    } as any);
    const spec = legacySpec(repository.id);
    run = await AgentRun.create({
      projectId: project.id, taskId: task.id, status: 'succeeded', trigger: 'manual', currentStageIndex: 0,
      workspaceRevision: 1, resultSummary: 'Сверстал лендинг',
      pipelineSnapshot: { ...spec, finalAction },
    } as any);
    proposal = await AgentWorkspaceProposal.create({
      projectId: project.id, taskId: task.id, repositoryId: repository.id, workerId: 'worker-1',
      workspaceKey: '/srv/repo', workspacePath: '/srv/repo', reservationKey: 'worker-1:/srv/repo',
      initialRunId: run.id, latestRunId: run.id, revision: 1, latestDiffId: null,
      baseSha: 'a'.repeat(40), baseBranch: 'main', remote: 'origin', remoteUrl: repository.cloneUrl,
      remoteBaseSha: 'a'.repeat(40), expectedTreeSha: 'b'.repeat(40), targetMode: 'new',
      targetBranch: 'agentiz/landing-1a2b', commitMessage: 'Landing page', status: 'waiting_review',
    } as any);
    const diff = await AgentRunDiff.create({
      runId: run.id, projectId: project.id, repositoryId: repository.id, proposalId: proposal.id, revision: 1,
      baseSha: proposal.baseSha, treeSha: proposal.expectedTreeSha, patch: 'diff', patchSizeBytes: 4,
      patchSha256: 'c'.repeat(64), ops: [{ op: 'upsert', path: 'a', content: 'x', encoding: 'utf-8' }],
      stats: { files: 1, insertions: 1, deletions: 0 }, truncated: false,
    } as any);
    await proposal.update({ latestDiffId: diff.id });
    await run.update({ proposalId: proposal.id });
  }

  /** Approve, then answer the queued push job the way a worker does. */
  async function push(): Promise<Record<string, unknown>> {
    await AgentWorkspaceProposalService.approve(proposal.id, 1, 'reviewer');
    const job = await AgentRunJob.findOne({ where: { proposalId: proposal.id, jobKind: 'workspace_commit_push' } });
    return (AgentWorkerApiService as any).applyWorkspaceActionResult(job, { status: 'succeeded', commitSha: 'd'.repeat(40) });
  }

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    openPullRequest.mockReset();
    openPullRequest.mockResolvedValue({ url: 'https://github.com/webresto/promo/pull/8', number: 8 });
    vi.spyOn(RepositoryResolverService, 'providerFor').mockResolvedValue({ openPullRequest } as any);
  });

  it('a spec without the field pushes exactly as before: no PR, no provider, no extra log line', async () => {
    const spec = legacySpec('repo-id');
    expect(() => assertValidSpec(spec)).not.toThrow();
    await setUp(spec.finalAction as Record<string, unknown>);

    const result = await push();

    expect(result.proposalStatus).toBe('pushed');
    expect(RepositoryResolverService.providerFor).not.toHaveBeenCalled();
    expect((await run.reload()).responseUrl ?? null).toBeNull();
    expect(await AgentActivity.count({ where: { type: 'pr.opened' } })).toBe(0);
    expect(await AgentRunLog.count({ where: { runId: run.id } })).toBe(0);
  });

  it('opens the PR from the pushed branch and closes the issue it came from', async () => {
    await setUp({ type: 'commit', targetBranch: { mode: 'new' }, openPullRequest: true }, 'own');

    const result = await push();

    expect(result.proposalStatus).toBe('pushed');
    expect(openPullRequest).toHaveBeenCalledTimes(1);
    const params = openPullRequest.mock.calls[0][0];
    expect(params).toMatchObject({ branch: 'agentiz/landing-1a2b', baseBranch: 'main', title: 'Landing page' });
    expect(params.body.split('\n')[0]).toBe('Closes #7');
    expect(params.body).toContain('Сверстал лендинг');
    expect((await run.reload()).responseUrl).toBe('https://github.com/webresto/promo/pull/8');
    expect(await AgentActivity.count({ where: { type: 'pr.opened', runId: run.id } })).toBe(1);
  });

  it('a platform refusing the PR leaves the push successful and says so in the run log', async () => {
    await setUp({ type: 'commit', targetBranch: { mode: 'new' }, openPullRequest: true });
    openPullRequest.mockRejectedValue(new Error('A pull request already exists'));

    const result = await push();

    expect(result.proposalStatus).toBe('pushed');
    const job = await AgentRunJob.findOne({ where: { proposalId: proposal.id, jobKind: 'workspace_commit_push' } });
    expect(job!.status).toBe('succeeded');
    const warn = await AgentRunLog.findOne({ where: { runId: run.id, level: 'warn' } });
    expect(warn!.message).toContain('A pull request already exists');
  });

  it('names an issue only when it belongs to the repository of the PR', () => {
    const own = { id: 't', raw: { agentizIntegration: { repositoryId: 'repo-a', integrationId: 'l', issueNumber: 3 } } } as any;
    const foreign = { id: 't', raw: { agentizIntegration: { repositoryId: 'repo-b', integrationId: 'l', issueNumber: 3 } } } as any;
    const local = { id: 't', raw: null } as any;
    expect(workspacePullRequestBody(own, 'repo-a', 'r', 'ok')).toMatch(/^Closes #3\n\nok\n\n/);
    expect(workspacePullRequestBody(foreign, 'repo-a', 'r', 'ok')).not.toContain('Closes');
    expect(workspacePullRequestBody(local, 'repo-a', 'r', '')).toBe('Automated by agentiz run `r` for task `t`.');
  });

  it('refuses the field where there is no own branch or no repository to open it through', () => {
    const base = legacySpec('repo-id') as any;
    expect(() => assertValidSpec({ ...base, finalAction: { ...base.finalAction, openPullRequest: true } })).not.toThrow();
    expect(() => assertValidSpec({ ...base, finalAction: { type: 'commit', targetBranch: { mode: 'current' }, openPullRequest: true } }))
      .toThrow(/targetBranch.mode "new"/);
    expect(() => assertValidSpec({ ...base, source: { ...base.source, repositoryId: undefined }, finalAction: { ...base.finalAction, openPullRequest: true } }))
      .toThrow(/source.repositoryId/);
    expect(() => assertValidSpec({ stages: base.stages, finalAction: { type: 'commit_and_pr', openPullRequest: true } }))
      .toThrow(/commit_and_pr/);
  });
});
