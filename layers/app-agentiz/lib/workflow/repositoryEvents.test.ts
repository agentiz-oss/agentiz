import { EventEmitter } from 'events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { Sequelize } from 'sequelize-typescript';
import type { TriggerBindingContext, WorkflowEventBus } from '@nodeknit/app-workflow';
import * as agentizModels from '../../models';
import { AgentActivity } from '../../models/AgentActivity';
import { AgentGitConnection } from '../../models/AgentGitConnection';
import { AgentProject } from '../../models/AgentProject';
import { AgentProjectRepository } from '../../models/AgentProjectRepository';
import { AgentRepository } from '../../models/AgentRepository';
import { AgentRun } from '../../models/AgentRun';
import { AgentTask } from '../../models/AgentTask';
import { forgetWorkflowEvents, useWorkflowEvents } from './events';
import {
  AGENTIZ_REPOSITORY_CI_RUN,
  AGENTIZ_REPOSITORY_PACKAGE,
  AGENTIZ_REPOSITORY_PUSHED,
  type AgentizRepositoryCiRunPayload,
  type AgentizRepositoryPushedPayload,
} from './events';
import {
  forgetBranch,
  publishRepositoryCiRun,
  publishRepositoryPackage,
  publishRepositoryPush,
  seedWatchCursor,
  watchCursorOf,
  watchedRepositories,
} from './repositoryEvents';
import { repositoryEventTriggerNode, taskEventTriggerNode } from './nodes';
import { detachedWorkSettled } from '../detachedWork';

/**
 * The two halves of `.ai-notes/repository-events-workflow-plan.md` that no source can prove on its
 * own: what one repository fact turns into, and what the trigger node lets through.
 *
 * Both halves have an invariant that is easy to break by accident and invisible when broken —
 * a repository connected to two projects must raise **two** events off **one** observation, and a
 * push made by our own run must not wake the flow that made it. Neither shows up in a type error.
 */

/**
 * Listeners are synchronous, but `ctx.fire` is not — the trigger starts the flow out of band so
 * that a slow graph cannot hold up the poll pass or the webhook request that published the fact.
 *
 * Waited for by the barrier the trigger registers itself with (`lib/detachedWork.ts`) rather than
 * by a tick: "one tick is enough" is a statement about machine load, and every other file in this
 * folder that believed it failed under a full suite run.
 */
const settled = (): Promise<void> => detachedWorkSettled();

describe('repository events', () => {
  let sequelize: Sequelize;
  let emitter: EventEmitter;
  let projectA: string;
  let projectB: string;
  let repository: AgentRepository;

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
    emitter = new EventEmitter();
    emitter.setMaxListeners(50);
    useWorkflowEvents({ emitter: { emit: (key, payload) => { emitter.emit(key, payload); } } });

    projectA = (await AgentProject.create({ name: 'A', slug: 'a', ownerId: 1 } as any)).id;
    projectB = (await AgentProject.create({ name: 'B', slug: 'b', ownerId: 1 } as any)).id;
    const connection = await AgentGitConnection.create({
      provider: 'github', externalUserId: '1', username: 'octocat', status: 'active',
    } as any);
    repository = await AgentRepository.create({
      connectionId: connection.id, provider: 'github', externalRepoId: '42',
      pathWithNamespace: 'octocat/hello', owner: 'octocat', repo: 'hello',
      webUrl: 'https://github.com/octocat/hello', defaultBranch: 'main',
    } as any);
  });

  afterEach(() => {
    forgetWorkflowEvents();
    emitter.removeAllListeners();
  });

  async function link(projectId: string, isActive = true): Promise<AgentProjectRepository> {
    return AgentProjectRepository.create({
      projectId, provider: 'github', connectionId: repository.connectionId,
      repositoryId: repository.id, isActive,
    } as any);
  }

  function collect<T>(eventKey: string): T[] {
    const seen: T[] = [];
    emitter.on(eventKey, (payload) => seen.push(payload as T));
    return seen;
  }

  const push = (patch: Record<string, unknown> = {}) => publishRepositoryPush(repository, {
    branch: 'main', beforeSha: 'aaa', afterSha: 'bbb', forced: false,
    commits: [{ sha: 'bbb', message: 'fix', author: 'octocat', url: 'https://x' }],
    compareUrl: 'https://compare', ...patch,
  } as any);

  // -------------------------------------------------------------------------
  // publication
  // -------------------------------------------------------------------------

  it('one observation of a repository in two projects raises two events, one per link', async () => {
    await link(projectA);
    await link(projectB);
    const seen = collect<AgentizRepositoryPushedPayload>(AGENTIZ_REPOSITORY_PUSHED);

    const publication = await push();

    expect(publication.emitted).toBe(2);
    expect(seen.map((payload) => payload.projectId).sort()).toEqual([projectA, projectB].sort());
    // The repository is one thing to both; the link is what differs, and that is what a node needs
    // to tell one copy of the event from the other.
    expect(new Set(seen.map((payload) => payload.repositoryId)).size).toBe(1);
    expect(new Set(seen.map((payload) => payload.projectRepositoryId)).size).toBe(2);
  });

  it('a link that is switched off gets no events', async () => {
    await link(projectA);
    await link(projectB, false);
    const seen = collect<AgentizRepositoryPushedPayload>(AGENTIZ_REPOSITORY_PUSHED);

    await push();

    expect(seen.map((payload) => payload.projectId)).toEqual([projectA]);
  });

  it('moves the cursor and writes a feed row for every project it reached', async () => {
    await link(projectA);
    await link(projectB);

    await push({ branch: 'feature/x', afterSha: 'ccc' });

    await repository.reload();
    expect(watchCursorOf(repository).branchHeads['feature/x']).toBe('ccc');
    expect(watchCursorOf(repository).checkedAt).not.toBe('');
    expect(await AgentActivity.count({ where: { type: 'repository.pushed' } })).toBe(2);
  });

  it('attributes a push to the run whose branch it is, per project', async () => {
    await link(projectA);
    const task = await AgentTask.create({
      projectId: projectA, externalId: 'local:1', title: 'фича', status: 'new', priority: 'normal',
    } as any);
    const run = await AgentRun.create({
      taskId: task.id, projectId: projectA, status: 'succeeded', trigger: 'manual',
      pipelineSnapshot: { stages: [] }, currentStageIndex: 0, branch: 'agentiz/feature-x',
    } as any);
    const seen = collect<AgentizRepositoryPushedPayload>(AGENTIZ_REPOSITORY_PUSHED);

    await push({ branch: 'agentiz/feature-x' });

    expect(seen[0].ownRunId).toBe(run.id);
    expect(seen[0].ownTaskId).toBe(task.id);
    // The same id under the name every node downstream actually reads.
    expect(seen[0].taskId).toBe(task.id);
  });

  it('leaves taskId absent on a push no run of ours made', async () => {
    await link(projectA);
    const seen = collect<AgentizRepositoryPushedPayload>(AGENTIZ_REPOSITORY_PUSHED);

    await push({ branch: 'somebody-else' });

    expect(seen[0].ownRunId).toBeNull();
    // Absent, not null: `agentiz.task.create` downstream is what gives the flow a task, and a
    // present-but-null `taskId` would look to `payloadOf` like a task that cannot be loaded.
    expect('taskId' in seen[0]).toBe(false);
  });

  it('a CI run advances only the run half of the cursor and keeps branch heads', async () => {
    await link(projectA);
    await push({ branch: 'main', afterSha: 'bbb' });

    const seen = collect<AgentizRepositoryCiRunPayload>(AGENTIZ_REPOSITORY_CI_RUN);
    await publishRepositoryCiRun(repository, {
      branch: 'main', headSha: 'bbb', workflowName: 'CI', conclusion: 'failure',
      url: 'https://run/7', externalRunId: '7',
    });

    await repository.reload();
    expect(watchCursorOf(repository).lastCiRunId).toBe(7);
    expect(watchCursorOf(repository).branchHeads.main).toBe('bbb');
    expect(seen[0].conclusion).toBe('failure');
  });

  it('never lets the CI cursor move backwards', async () => {
    await link(projectA);
    const run = (id: string) => publishRepositoryCiRun(repository, {
      branch: 'main', headSha: 'x', workflowName: 'CI', conclusion: 'success',
      url: 'https://run', externalRunId: id,
    });

    await run('9');
    await run('4');

    await repository.reload();
    expect(watchCursorOf(repository).lastCiRunId).toBe(9);
  });

  it('a deleted branch is silence plus a cleaned cursor, not an event', async () => {
    await link(projectA);
    await push({ branch: 'gone', afterSha: 'ddd' });
    const seen = collect<AgentizRepositoryPushedPayload>(AGENTIZ_REPOSITORY_PUSHED);

    await repository.reload();
    await forgetBranch(repository, 'gone');

    expect(seen).toHaveLength(0);
    await repository.reload();
    expect(watchCursorOf(repository).branchHeads.gone).toBeUndefined();
  });

  it('seeding fills the cursor and emits nothing at all', async () => {
    await link(projectA);
    const pushes = collect<unknown>(AGENTIZ_REPOSITORY_PUSHED);
    const ci = collect<unknown>(AGENTIZ_REPOSITORY_CI_RUN);

    await seedWatchCursor(repository, { branchHeads: { main: 'aaa', dev: 'bbb' }, lastCiRunId: 12 });

    expect(pushes).toHaveLength(0);
    expect(ci).toHaveLength(0);
    await repository.reload();
    expect(watchCursorOf(repository).branchHeads).toEqual({ main: 'aaa', dev: 'bbb' });
    expect(watchCursorOf(repository).lastCiRunId).toBe(12);
    expect(await AgentActivity.count()).toBe(0);
  });

  it('watches only repositories some project actually uses', async () => {
    expect(await watchedRepositories('github')).toHaveLength(0);
    await link(projectA, false);
    expect(await watchedRepositories('github')).toHaveLength(0);
    await link(projectB);
    expect((await watchedRepositories('github')).map((row) => row.id)).toEqual([repository.id]);
  });

  // -------------------------------------------------------------------------
  // the trigger node
  // -------------------------------------------------------------------------

  describe('agentiz.repository.trigger', () => {
    const fired: Array<Record<string, unknown>> = [];

    function bind(config: Record<string, unknown>, listenerKey = 'flow:s:n'): TriggerBindingContext {
      const eventBus = {
        emit: (key: string, payload: unknown) => { emitter.emit(key, payload); },
        on: (key: string, listener: (payload: unknown) => void) => {
          const handler = (payload: unknown) => listener(payload);
          emitter.on(key, handler);
          return (): void => { emitter.off(key, handler); };
        },
      } as unknown as WorkflowEventBus;
      const ctx = {
        config, listenerKey, specId: 's', nodeId: 'n', eventBus,
        fire: async (msg: any) => { fired.push(msg.payload); },
      } as unknown as TriggerBindingContext;
      repositoryEventTriggerNode.trigger!.bind(ctx);
      return ctx;
    }

    beforeEach(async () => {
      fired.length = 0;
      await link(projectA);
    });

    it('filters by project, repository and branch mask', async () => {
      bind({ projectId: projectA, repositoryId: repository.id, branches: 'main, release/*' });

      await push({ branch: 'main' });
      await push({ branch: 'release/1.2' });
      await push({ branch: 'release/1/2' });
      await push({ branch: 'dev' });
      await settled();

      expect(fired.map((payload) => payload.branch)).toEqual(['main', 'release/1.2']);
    });

    it('a foreign project or repository never reaches the node', async () => {
      bind({ projectId: projectB });
      await push();
      await settled();
      expect(fired).toHaveLength(0);

      fired.length = 0;
      bind({ repositoryId: 'somebody-elses-id' }, 'flow:s:n2');
      await push();
      await settled();
      expect(fired).toHaveLength(0);
    });

    it('skips our own pushes by default and lets our own CI runs through', async () => {
      const task = await AgentTask.create({
        projectId: projectA, externalId: 'local:1', title: 'фича', status: 'new', priority: 'normal',
      } as any);
      await AgentRun.create({
        taskId: task.id, projectId: projectA, status: 'succeeded', trigger: 'manual',
        pipelineSnapshot: { stages: [] }, currentStageIndex: 0, branch: 'agentiz/x',
      } as any);

      bind({ event: AGENTIZ_REPOSITORY_PUSHED }, 'flow:s:push');
      bind({ event: AGENTIZ_REPOSITORY_CI_RUN }, 'flow:s:ci');

      await push({ branch: 'agentiz/x' });
      await publishRepositoryCiRun(repository, {
        branch: 'agentiz/x', headSha: 'bbb', workflowName: 'CI', conclusion: 'failure',
        url: 'https://run/1', externalRunId: '1',
      });
      await settled();

      // Exactly one: the CI one. The push of our own run is the loop this default exists to stop.
      expect(fired).toHaveLength(1);
      expect(fired[0].conclusion).toBe('failure');
      expect(fired[0].taskId).toBe(task.id);
    });

    it('honours an explicit ignoreOwnRuns in either direction', async () => {
      const task = await AgentTask.create({
        projectId: projectA, externalId: 'local:2', title: 'фича', status: 'new', priority: 'normal',
      } as any);
      await AgentRun.create({
        taskId: task.id, projectId: projectA, status: 'succeeded', trigger: 'manual',
        pipelineSnapshot: { stages: [] }, currentStageIndex: 0, branch: 'agentiz/y',
      } as any);

      bind({ event: AGENTIZ_REPOSITORY_PUSHED, ignoreOwnRuns: false });
      await push({ branch: 'agentiz/y' });
      await settled();
      expect(fired).toHaveLength(1);

      fired.length = 0;
      bind({ event: AGENTIZ_REPOSITORY_CI_RUN, ignoreOwnRuns: true }, 'flow:s:ci2');
      await publishRepositoryCiRun(repository, {
        branch: 'agentiz/y', headSha: 'b', workflowName: 'CI', conclusion: 'failure',
        url: 'https://run/2', externalRunId: '2',
      });
      await settled();
      expect(fired).toHaveLength(0);
    });

    it('filters CI by conclusion and workflow name', async () => {
      bind({ event: AGENTIZ_REPOSITORY_CI_RUN, conclusion: 'failure, timed_out', workflowName: 'CI' });

      const ci = (conclusion: string, name: string, id: string) => publishRepositoryCiRun(repository, {
        branch: 'main', headSha: 'b', workflowName: name, conclusion,
        url: 'https://run', externalRunId: id,
      });
      await ci('failure', 'CI', '1');
      await ci('success', 'CI', '2');
      await ci('failure', 'Release', '3');
      await settled();

      expect(fired).toHaveLength(1);
      expect(fired[0].conclusion).toBe('failure');
    });

    const publishPackage = (patch: Partial<Parameters<typeof publishRepositoryPackage>[1]> = {}) =>
      publishRepositoryPackage(repository, {
        packageName: 'hello', packageType: 'container', namespace: 'octocat', action: 'published',
        version: 'sha256:beef', tag: 'v1.2.3', digest: 'sha256:beef',
        packageUrl: 'ghcr.io/octocat/hello', htmlUrl: 'https://pkg', ...patch,
      });

    it('filters a package by name and tag masks, case-insensitively', async () => {
      bind({ event: AGENTIZ_REPOSITORY_PACKAGE, packageName: 'hello, *-worker', tag: 'v*, latest' });

      await publishPackage({ tag: 'v1.2.3' });
      await publishPackage({ tag: 'LATEST' });
      await publishPackage({ tag: 'edge' });
      await publishPackage({ packageName: 'docs', tag: 'v2' });
      await publishPackage({ packageName: 'api-worker', tag: 'v2' });
      await settled();

      expect(fired.map((payload) => `${payload.packageName}:${payload.tag}`))
        .toEqual(['hello:v1.2.3', 'hello:LATEST', 'api-worker:v2']);
    });

    it('a package without a tag does not match a node that names one', async () => {
      bind({ event: AGENTIZ_REPOSITORY_PACKAGE, tag: 'latest' }, 'flow:s:tagged');
      bind({ event: AGENTIZ_REPOSITORY_PACKAGE }, 'flow:s:any');

      await publishPackage({ packageType: 'npm', tag: '', digest: '', version: '1.4.0' });
      await settled();

      // One node saw it — the one that asked for any tag. Empty is not "matches everything".
      expect(fired).toHaveLength(1);
      expect(fired[0].version).toBe('1.4.0');
    });

    it('branches and ignoreOwnRuns do not apply to a package event', async () => {
      const task = await AgentTask.create({
        projectId: projectA, externalId: 'local:3', title: 'фича', status: 'new', priority: 'normal',
      } as any);
      await AgentRun.create({
        taskId: task.id, projectId: projectA, status: 'succeeded', trigger: 'manual',
        pipelineSnapshot: { stages: [] }, currentStageIndex: 0, branch: 'agentiz/z',
      } as any);
      // A branch mask that matches nothing and the strictest own-run setting: neither is read on
      // this event, so the package still arrives. An image has no branch and no attribution.
      bind({ event: AGENTIZ_REPOSITORY_PACKAGE, branches: 'never/*', ignoreOwnRuns: true });

      await publishPackage();
      await settled();

      expect(fired).toHaveLength(1);
      expect('taskId' in fired[0]).toBe(false);
    });

    it('binding twice with the same listenerKey leaves one listener, not two', async () => {
      bind({ projectId: projectA });
      bind({ projectId: projectA });

      await push();
      await settled();

      expect(fired).toHaveLength(1);
    });
  });

  describe('publishing a package', () => {
    it('fans out per project, journals, and moves no cursor', async () => {
      await link(projectA);
      await link(projectB);
      await publishRepositoryPush(repository, {
        branch: 'main', beforeSha: 'a', afterSha: 'b', forced: false, commits: [], compareUrl: null,
      });
      await repository.reload();
      const cursorBefore = JSON.stringify(watchCursorOf(repository));

      const result = await publishRepositoryPackage(repository, {
        packageName: 'hello', packageType: 'container', namespace: 'octocat', action: 'published',
        version: 'sha256:beef', tag: 'v1', digest: 'sha256:beef',
        packageUrl: 'ghcr.io/octocat/hello', htmlUrl: 'https://pkg',
      });

      expect(result).toEqual({ emitted: 2, ownRunId: null, ownTaskId: null });
      expect(await AgentActivity.count({ where: { type: 'repository.package' } })).toBe(2);
      // No poll observes a registry, so there is no second source to keep quiet — a cursor here
      // would be bookkeeping nobody reads.
      await repository.reload();
      expect(JSON.stringify(watchCursorOf(repository))).toBe(cursorBefore);
    });
  });

  // -------------------------------------------------------------------------
  // backwards compatibility
  // -------------------------------------------------------------------------

  it('a graph saved before this node existed is untouched by it', async () => {
    // The proof AGENTS.md asks for, and it is cheap here because nothing existing was edited: the
    // task trigger keeps its own event list, its own config and its own listener registry, so a
    // spec that names `agentiz.task.trigger` cannot start seeing repository events.
    const schema = taskEventTriggerNode.configSchema as any;
    expect(schema.properties.event.enum).toEqual([
      'agentiz.task.created', 'agentiz.task.updated', 'agentiz.task.commented',
    ]);
    expect(schema.properties.repositoryId).toBeUndefined();
    expect(schema.properties.packageName).toBeUndefined();
    expect(taskEventTriggerNode.ui).toBeUndefined();

    await link(projectA);
    const fired: unknown[] = [];
    const eventBus = {
      emit: (): void => undefined,
      on: (key: string, listener: (payload: unknown) => void) => {
        const handler = (payload: unknown) => listener(payload);
        emitter.on(key, handler);
        return (): void => { emitter.off(key, handler); };
      },
    } as unknown as WorkflowEventBus;
    taskEventTriggerNode.trigger!.bind({
      config: {}, listenerKey: 'legacy:s:n', specId: 's', nodeId: 'n', eventBus,
      fire: async () => { fired.push(true); },
    } as unknown as TriggerBindingContext);

    await push();
    await publishRepositoryCiRun(repository, {
      branch: 'main', headSha: 'b', workflowName: 'CI', conclusion: 'failure',
      url: 'https://run', externalRunId: '1',
    });
    await settled();

    expect(fired).toHaveLength(0);
  });
});
