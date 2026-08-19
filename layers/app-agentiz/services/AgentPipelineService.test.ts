import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../models';
import { AgentProject } from '../models/AgentProject';
import { AgentRun } from '../models/AgentRun';
import { AgentTask } from '../models/AgentTask';
import { AgentWorker } from '../models/AgentWorker';
import { AgentWorkspaceProposal } from '../models/AgentWorkspaceProposal';
import { AgentWorkerJobBuilder } from './AgentPipelineService';

/**
 * The reservation guard in `buildSnapshot`. A workspace is one directory on one worker, but a spec
 * may name it either by declared key or by absolute path — and the two names must not buy two
 * reservations on the same checkout.
 */
describe('AgentWorkerJobBuilder workspace reservation', () => {
  let sequelize: Sequelize;
  let project: AgentProject;
  let task: AgentTask;
  let worker: AgentWorker;

  const snapshotFor = (workspace: Record<string, unknown>): Record<string, unknown> => ({
    stages: [],
    finalAction: { type: 'commit', targetBranch: { mode: 'new' } },
    source: { kind: 'worker_workspace', workspace },
  });

  const reserve = async (name: string) => AgentWorkspaceProposal.create({
    projectId: project.id, taskId: task.id, repositoryId: null, workerId: worker.id,
    workspaceKey: name, workspacePath: '/srv/repo', reservationKey: `${worker.id}:${name}`,
    initialRunId: 'run-0', latestRunId: 'run-0', revision: 1, latestDiffId: null,
    baseSha: 'a'.repeat(40), baseBranch: 'main', remote: 'origin', remoteUrl: 'git@github.com:acme/repo.git',
    remoteBaseSha: 'a'.repeat(40), expectedTreeSha: 'b'.repeat(40), targetMode: 'new',
    targetBranch: 'agentiz/fix', commitMessage: 'Fix', status: 'waiting_review',
  } as any);

  const runFor = async (workspace: Record<string, unknown>) => AgentRun.create({
    projectId: project.id, taskId: task.id, status: 'pending', trigger: 'manual', currentStageIndex: 0,
    proposalId: null, workspaceRevision: null, pipelineSnapshot: snapshotFor(workspace),
  } as any);

  beforeAll(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, models: Object.values(agentizModels) as any[] });
  });

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    project = await AgentProject.create({ name: 'Test', slug: 'test', ownerId: 1 } as any);
    task = await AgentTask.create({ projectId: project.id, externalId: 'local:1', title: 'Fix auth', status: 'queued', priority: 'normal' } as any);
    worker = await AgentWorker.create({
      name: 'worker-1', status: 'active', workspaces: [{ key: 'repo', path: '/srv/repo', git: { pushEnabled: true } }],
      capabilities: { workspaceGit: true },
    } as any);
  });

  afterAll(async () => sequelize.close());

  // The incident this test exists for: a spec rewritten from `path` to `workspaceKey` kept pointing
  // at the same checkout, but the guard only compared reservation keys, so the run was queued and
  // died on the worker's on-disk marker instead — naming a proposal nobody could locate.
  it('rejects a key-named run while the same path is reserved under its path name', async () => {
    const reservation = await reserve('/srv/repo');
    const run = await runFor({ workerId: worker.id, workspaceKey: 'repo' });
    await expect(AgentWorkerJobBuilder.buildSnapshot(run)).rejects.toThrow(
      new RegExp(`Workspace "repo" \\(/srv/repo\\) is reserved by proposal ${reservation.id}`),
    );
  });

  it('rejects a path-named run while the same path is reserved under its declared key', async () => {
    const reservation = await reserve('repo');
    const run = await runFor({ workerId: worker.id, path: '/srv/repo' });
    await expect(AgentWorkerJobBuilder.buildSnapshot(run)).rejects.toThrow(
      new RegExp(`Workspace "/srv/repo" is reserved by proposal ${reservation.id}`),
    );
  });

  // The snapshot is the only thing the worker reads, so an opt-out that never reaches it is not an
  // opt-out. Absent means stash — including for every spec written before the field existed.
  it('defaults the dirty-workspace policy to stash, including for specs written before the field', async () => {
    const run = await runFor({ workerId: worker.id, workspaceKey: 'repo' });
    await expect(AgentWorkerJobBuilder.buildSnapshot(run)).resolves.toMatchObject({
      workspace: { stashDirty: true },
    });
  });

  it('carries the opt-out to the worker', async () => {
    const run = await runFor({ workerId: worker.id, workspaceKey: 'repo', stashDirty: false });
    await expect(AgentWorkerJobBuilder.buildSnapshot(run)).resolves.toMatchObject({
      workspace: { stashDirty: false },
    });
  });

  it('ignores a released reservation on the same directory', async () => {
    const stale = await reserve('/srv/repo');
    await stale.update({ status: 'pushed', reservationKey: null });
    const run = await runFor({ workerId: worker.id, workspaceKey: 'repo' });
    await expect(AgentWorkerJobBuilder.buildSnapshot(run)).resolves.toMatchObject({
      workspace: { path: '/srv/repo', key: 'repo' },
    });
  });

  it('lets the run that owns the reservation continue', async () => {
    const reservation = await reserve('repo');
    const run = await runFor({ workerId: worker.id, workspaceKey: 'repo' });
    await run.update({ proposalId: reservation.id, workspaceRevision: 1 });
    await reservation.update({ latestRunId: run.id });
    await expect(AgentWorkerJobBuilder.buildSnapshot(run)).resolves.toMatchObject({
      workspace: { path: '/srv/repo' },
    });
  });
});
