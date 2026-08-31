import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../../models';
import { AgentProject } from '../../models/AgentProject';
import { AgentRun } from '../../models/AgentRun';
import { AgentRunDiff } from '../../models/AgentRunDiff';
import { AgentTask } from '../../models/AgentTask';
import { AgentWorkspaceProposal } from '../../models/AgentWorkspaceProposal';
import { collectRunFacts } from './runPayload';
import { branchToHostLabel } from '../workspaceBranch';

/**
 * What a finished run tells a graph about itself — and, in equal measure, what it told a graph
 * *before* it told it anything.
 *
 * The second half is the point. `msg.payload` after an `agentiz.pipeline` node is read by every
 * template in every saved graph (`{{payload.summary}}`, `{{payload.verdict}}`, …), so adding
 * fields to it is exactly the kind of change AGENTS.md demands proof for: a graph written
 * yesterday has to render the same text today. The proof here is in two parts — the pre-existing
 * keys keep their values and their spelling, and a run that produced nothing produces facts that
 * are all null, so `{{payload.branch}}` renders to the same empty string it did when the field did
 * not exist at all.
 */
describe('run facts in the workflow payload', () => {
  let sequelize: Sequelize;
  let projectId: string;
  let taskId: string;

  beforeAll(async () => {
    sequelize = new Sequelize({
      dialect: 'sqlite', storage: ':memory:', logging: false,
      models: Object.values(agentizModels) as any[],
    });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    projectId = (await AgentProject.create({ name: 'P', slug: 'lyapka', ownerId: 1 } as any)).id;
    taskId = (await AgentTask.create({
      projectId, externalId: 'local:1', title: 'Подвал с годом', status: 'new', priority: 'normal',
    } as any)).id;
  });

  async function makeRun(patch: Record<string, unknown> = {}): Promise<AgentRun> {
    return AgentRun.create({
      taskId, projectId, status: 'succeeded', trigger: 'manual',
      pipelineSnapshot: { stages: [] }, currentStageIndex: 0, ...patch,
    } as any);
  }

  it('a run that produced nothing produces no facts — every field is null or false', async () => {
    const facts = await collectRunFacts(await makeRun());

    expect(facts.branch).toBeNull();
    expect(facts.branchSlug).toBeNull();
    expect(facts.commitSha).toBeNull();
    expect(facts.commitShort).toBeNull();
    expect(facts.commitUrl).toBeNull();
    expect(facts.prUrl).toBeNull();
    expect(facts.pushed).toBe(false);
    expect(facts.filesChanged).toBeNull();
    // The task and the project are always there, and always were readable through `taskId`.
    expect(facts.taskTitle).toBe('Подвал с годом');
    expect(facts.projectSlug).toBe('lyapka');
  });

  it('reads a repository run off the run row itself', async () => {
    const run = await makeRun({
      branch: 'agentiz/podval-god-3f1a',
      commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      commitUrl: 'https://gitlab.example/-/commit/a1b2c3',
      responseUrl: 'https://gitlab.example/-/merge_requests/12',
      baseRef: 'main',
    });

    const facts = await collectRunFacts(run);

    expect(facts.branch).toBe('agentiz/podval-god-3f1a');
    expect(facts.branchSlug).toBe('agentiz-podval-god-3f1a');
    expect(facts.commitShort).toBe('a1b2c3d4e5f6');
    expect(facts.prUrl).toBe('https://gitlab.example/-/merge_requests/12');
    expect(facts.baseRef).toBe('main');
    // No proposal: delivery for a repository run *is* the commit that already happened.
    expect(facts.pushed).toBe(true);
  });

  it('falls back to the proposal for a workspace run, and says the branch is not pushed yet', async () => {
    const run = await makeRun();
    const proposal = await AgentWorkspaceProposal.create({
      projectId, taskId, workerId: 'w1', workspaceKey: 'ws', workspacePath: '/srv/ws',
      initialRunId: run.id, latestRunId: run.id, remote: 'origin',
      targetMode: 'new', targetBranch: 'agentiz/podval-god-3f1a',
      commitMessage: 'подвал', status: 'waiting_review',
    } as any);
    await run.update({ proposalId: proposal.id });

    const facts = await collectRunFacts(run);

    expect(facts.branch).toBe('agentiz/podval-god-3f1a');
    // The whole reason this field exists: the push is a separate job that has not run yet, and a
    // template must be able to name the branch without claiming it is already in the remote.
    expect(facts.pushed).toBe(false);
    expect(facts.pushedAt).toBeNull();

    await proposal.update({ status: 'pushed', pushedAt: new Date(), pushedCommitSha: 'deadbeefcafe0011' });
    const after = await collectRunFacts(await AgentRun.findByPk(run.id) as AgentRun);
    expect(after.pushed).toBe(true);
    expect(after.commitShort).toBe('deadbeefcafe');
  });

  it('counts the diff when there is one', async () => {
    const run = await makeRun();
    await AgentRunDiff.create({
      runId: run.id, projectId, stats: { files: 13, insertions: 1672, deletions: 326 },
      ops: [], patch: null,
    } as any);

    const facts = await collectRunFacts(run);

    expect(facts.filesChanged).toBe(13);
    expect(facts.insertions).toBe(1672);
    expect(facts.deletions).toBe(326);
  });

  it('never lets a branch name become a hostname it is not', () => {
    expect(branchToHostLabel('agentiz/fix-login-3f1a')).toBe('agentiz-fix-login-3f1a');
    expect(branchToHostLabel('Feature/Логин')).toBe('feature');
    expect(branchToHostLabel(null)).toBeNull();
    expect(branchToHostLabel('---')).toBeNull();
    // A label longer than 63 characters is refused rather than cut: a truncated name would map two
    // different branches onto one host.
    expect(branchToHostLabel(`agentiz/${'a'.repeat(70)}`)).toBeNull();
  });
});
