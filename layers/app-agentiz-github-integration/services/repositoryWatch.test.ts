import { EventEmitter } from 'events';
import { createHmac } from 'crypto';
import type { AddressInfo } from 'net';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
  generateAdminizerModelConfig: () => ({}),
}));

/**
 * The GitHub half of `.ai-notes/repository-events-workflow-plan.md`: the 15-minute poll, the hook
 * we install ourselves, and the delivery those hooks produce.
 *
 * The claim these two sources make together is the one worth testing, and neither can make it
 * alone: **what one source already reported, the other stays silent about**, because the cursor is
 * one. So the delivery tests end by running a poll pass and asserting nothing more comes out.
 */

/** Whatever the service asks GitHub for, answered from a script the test writes. */
const fake = {
  branches: [] as Array<{ name: string; commit: { sha: string } }>,
  runs: [] as Array<Record<string, unknown>>,
  comparisons: new Map<string, { status: string; html_url: string; commits: any[] }>(),
  hooks: [] as Array<{ id: number; name: string; active: boolean; events: string[]; config: { url?: string } }>,
  created: [] as Array<{ url: string; secret: string; events: string[] }>,
  updated: [] as Array<{ hookId: string; events: string[] }>,
  deleted: [] as string[],
  pinged: [] as string[],
  calls: [] as string[],
};

const fakeClient = {
  async listBranches() { fake.calls.push('branches'); return fake.branches; },
  async listWorkflowRuns() { fake.calls.push('runs'); return fake.runs; },
  async compareCommits(_o: string, _r: string, base: string, head: string) {
    fake.calls.push(`compare:${base}...${head}`);
    const found = fake.comparisons.get(`${base}...${head}`);
    if (!found) throw new Error(`no comparison scripted for ${base}...${head}`);
    return found;
  },
  async listHooks(): Promise<typeof fake.hooks> { fake.calls.push('listHooks'); return fake.hooks; },
  async createHook(_o: string, _r: string, input: { url: string; secret: string; events: string[] }) {
    fake.calls.push('createHook');
    fake.created.push(input);
    const hook = { id: 555, name: 'web', active: true, events: input.events, config: { url: input.url } };
    fake.hooks.push(hook);
    return hook;
  },
  async updateHook(_o: string, _r: string, hookId: string, input: { events: string[] }) {
    fake.calls.push('updateHook');
    fake.updated.push({ hookId, events: input.events });
    const hook = fake.hooks.find((candidate) => String(candidate.id) === hookId);
    if (hook) hook.events = input.events;
    return hook ?? { id: Number(hookId), name: 'web', active: true, events: input.events, config: {} };
  },
  async deleteHook(_o: string, _r: string, hookId: string): Promise<void> { fake.calls.push('deleteHook'); fake.deleted.push(hookId); },
  async pingHook(_o: string, _r: string, hookId: string): Promise<void> { fake.calls.push('pingHook'); fake.pinged.push(hookId); },
};

vi.mock('./GithubOAuthService', () => ({
  GithubOAuthService: {
    apiClientFor: async (): Promise<typeof fakeClient> => fakeClient,
    getAccessToken: async (): Promise<string> => 'token',
    disconnect: async (): Promise<void> => undefined,
  },
}));

import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../../app-agentiz/models';
import { AgentActivity } from '../../app-agentiz/models/AgentActivity';
import { AgentGitConnection } from '../../app-agentiz/models/AgentGitConnection';
import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { AgentProjectRepository } from '../../app-agentiz/models/AgentProjectRepository';
import { AgentRepository } from '../../app-agentiz/models/AgentRepository';
import { AgentRun } from '../../app-agentiz/models/AgentRun';
import { AgentTask } from '../../app-agentiz/models/AgentTask';
import { registerGitConnectionAuthority, unregisterGitConnectionAuthority } from '../../app-agentiz/lib/git';
import { registerWebhookHost, registerWebhookMapper, unregisterWebhookHost, unregisterWebhookMapper } from '../../app-agentiz/lib/webhooks';
import { syncRepositoryWebhook } from '../../app-agentiz/lib/webhooks/repositoryWebhook';
import { detachedWorkSettled } from '../../app-agentiz/lib/detachedWork';
import {
  AGENTIZ_REPOSITORY_CI_RUN,
  AGENTIZ_REPOSITORY_PACKAGE,
  AGENTIZ_REPOSITORY_PUSHED,
  forgetWorkflowEvents,
  useWorkflowEvents,
  type AgentizRepositoryCiRunPayload,
  type AgentizRepositoryPackagePayload,
  type AgentizRepositoryPushedPayload,
} from '../../app-agentiz/lib/workflow/events';
import { watchCursorOf } from '../../app-agentiz/lib/workflow/repositoryEvents';
import { AgentWebhookDelivery } from '../../app-agentiz-webhooks/models/AgentWebhookDelivery';
import { AgentWebhookEndpoint } from '../../app-agentiz-webhooks/models/AgentWebhookEndpoint';
import { createWebhookRouter } from '../../app-agentiz-webhooks/lib/webhookRouter';
import { GithubRepositoryEventService } from './GithubRepositoryEventService';
import { githubRepositoryWebhookMapper } from './GithubWebhookService';
import { githubConnectionAuthority } from './GithubRepositorySyncService';

describe('watching a GitHub repository', () => {
  let sequelize: Sequelize;
  let emitter: EventEmitter;
  let projectA: string;
  let projectB: string;
  let connection: AgentGitConnection;
  let repository: AgentRepository;

  beforeAll(async () => {
    sequelize = new Sequelize({
      dialect: 'sqlite', storage: ':memory:', logging: false,
      models: [...Object.values(agentizModels) as any[], AgentWebhookEndpoint, AgentWebhookDelivery],
    });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    Object.assign(fake, {
      branches: [], runs: [], comparisons: new Map(), hooks: [],
      created: [], updated: [], deleted: [], pinged: [], calls: [],
    });
    emitter = new EventEmitter();
    emitter.setMaxListeners(50);
    useWorkflowEvents({ emitter: { emit: (key, payload) => { emitter.emit(key, payload); } } });

    projectA = (await AgentProject.create({ name: 'A', slug: 'a', ownerId: 1 } as any)).id;
    projectB = (await AgentProject.create({ name: 'B', slug: 'b', ownerId: 1 } as any)).id;
    connection = await AgentGitConnection.create({
      provider: 'github', externalUserId: '1', username: 'octocat', status: 'active', scope: 'repo,user',
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

  async function link(projectId: string): Promise<AgentProjectRepository> {
    return AgentProjectRepository.create({
      projectId, provider: 'github', connectionId: connection.id,
      repositoryId: repository.id, isActive: true,
    } as any);
  }

  function collect<T>(eventKey: string): T[] {
    const seen: T[] = [];
    emitter.on(eventKey, (payload) => seen.push(payload as T));
    return seen;
  }

  const poll = async () => {
    await repository.reload();
    return GithubRepositoryEventService.poll(repository);
  };

  // -------------------------------------------------------------------------
  // the poll
  // -------------------------------------------------------------------------

  describe('the 15-minute poll', () => {
    it('says nothing on the first pass and only remembers where the repository stands', async () => {
      await link(projectA);
      fake.branches = [{ name: 'main', commit: { sha: 'aaa' } }, { name: 'dev', commit: { sha: 'bbb' } }];
      fake.runs = [{ id: 12 }, { id: 9 }];
      const pushes = collect<unknown>(AGENTIZ_REPOSITORY_PUSHED);
      const ci = collect<unknown>(AGENTIZ_REPOSITORY_CI_RUN);

      const result = await poll();

      expect(result.seeded).toBe(true);
      expect(pushes).toHaveLength(0);
      expect(ci).toHaveLength(0);
      expect(await AgentActivity.count()).toBe(0);
      await repository.reload();
      expect(watchCursorOf(repository).branchHeads).toEqual({ main: 'aaa', dev: 'bbb' });
      expect(watchCursorOf(repository).lastCiRunId).toBe(12);
      // Never `/compare` while seeding — that is the flood the first pass exists to avoid.
      expect(fake.calls.filter((call) => call.startsWith('compare'))).toHaveLength(0);
    });

    it('reports the one branch that moved on the second pass', async () => {
      await link(projectA);
      fake.branches = [{ name: 'main', commit: { sha: 'aaa' } }, { name: 'dev', commit: { sha: 'bbb' } }];
      await poll();

      fake.branches = [{ name: 'main', commit: { sha: 'ccc' } }, { name: 'dev', commit: { sha: 'bbb' } }];
      fake.comparisons.set('aaa...ccc', {
        status: 'ahead', html_url: 'https://compare',
        commits: [{ sha: 'ccc', html_url: 'https://c', commit: { message: 'fix', author: { name: 'Ann' } }, author: { login: 'ann' } }],
      });
      const seen = collect<AgentizRepositoryPushedPayload>(AGENTIZ_REPOSITORY_PUSHED);
      await advanceActivity();

      const result = await poll();

      expect(result.pushes).toBe(1);
      expect(seen).toHaveLength(1);
      expect(seen[0].branch).toBe('main');
      expect(seen[0].beforeSha).toBe('aaa');
      expect(seen[0].afterSha).toBe('ccc');
      expect(seen[0].forced).toBe(false);
      expect(seen[0].commits).toEqual([{ sha: 'ccc', message: 'fix', author: 'ann', url: 'https://c' }]);
    });

    it('calls a force-push a force-push, on compare\'s own word', async () => {
      await link(projectA);
      fake.branches = [{ name: 'main', commit: { sha: 'aaa' } }];
      await poll();
      await advanceActivity();

      fake.branches = [{ name: 'main', commit: { sha: 'zzz' } }];
      fake.comparisons.set('aaa...zzz', { status: 'diverged', html_url: 'https://compare', commits: [] });
      const seen = collect<AgentizRepositoryPushedPayload>(AGENTIZ_REPOSITORY_PUSHED);

      await poll();

      expect(seen[0].forced).toBe(true);
    });

    it('a new branch arrives with beforeSha null and is compared against the default branch', async () => {
      await link(projectA);
      fake.branches = [{ name: 'main', commit: { sha: 'aaa' } }];
      await poll();
      await advanceActivity();

      fake.branches = [{ name: 'main', commit: { sha: 'aaa' } }, { name: 'feature/x', commit: { sha: 'fff' } }];
      fake.comparisons.set('main...fff', {
        status: 'ahead', html_url: 'https://compare',
        commits: [{ sha: 'fff', html_url: 'https://f', commit: { message: 'start' }, author: null }],
      });
      const seen = collect<AgentizRepositoryPushedPayload>(AGENTIZ_REPOSITORY_PUSHED);

      await poll();

      expect(seen).toHaveLength(1);
      expect(seen[0].branch).toBe('feature/x');
      expect(seen[0].beforeSha).toBeNull();
    });

    it('a deleted branch is silence, and its head leaves the cursor', async () => {
      await link(projectA);
      fake.branches = [{ name: 'main', commit: { sha: 'aaa' } }, { name: 'gone', commit: { sha: 'ggg' } }];
      await poll();
      await advanceActivity();

      fake.branches = [{ name: 'main', commit: { sha: 'aaa' } }];
      const seen = collect<unknown>(AGENTIZ_REPOSITORY_PUSHED);

      await poll();

      expect(seen).toHaveLength(0);
      await repository.reload();
      expect(watchCursorOf(repository).branchHeads).toEqual({ main: 'aaa' });
    });

    it('reports finished CI runs newer than the cursor, oldest first', async () => {
      await link(projectA);
      fake.branches = [];
      fake.runs = [{ id: 5 }];
      await poll();
      await advanceActivity();

      fake.runs = [
        { id: 7, name: 'CI', head_branch: 'main', head_sha: 'aaa', conclusion: 'failure', html_url: 'https://r/7' },
        { id: 6, name: 'CI', head_branch: 'main', head_sha: 'aaa', conclusion: 'success', html_url: 'https://r/6' },
        { id: 5, name: 'CI', head_branch: 'main', head_sha: 'aaa', conclusion: 'success', html_url: 'https://r/5' },
      ];
      const seen = collect<AgentizRepositoryCiRunPayload>(AGENTIZ_REPOSITORY_CI_RUN);

      await poll();

      expect(seen.map((payload) => payload.externalRunId)).toEqual(['6', '7']);
      await repository.reload();
      expect(watchCursorOf(repository).lastCiRunId).toBe(7);
    });

    it('a repository in two projects costs one set of requests and yields two events', async () => {
      await link(projectA);
      await link(projectB);
      fake.branches = [{ name: 'main', commit: { sha: 'aaa' } }];
      await poll();
      await advanceActivity();

      fake.branches = [{ name: 'main', commit: { sha: 'bbb' } }];
      fake.comparisons.set('aaa...bbb', { status: 'ahead', html_url: 'https://c', commits: [] });
      const seen = collect<AgentizRepositoryPushedPayload>(AGENTIZ_REPOSITORY_PUSHED);
      fake.calls.length = 0;

      await poll();

      expect(seen.map((payload) => payload.projectId).sort()).toEqual([projectA, projectB].sort());
      expect(fake.calls.filter((call) => call === 'branches')).toHaveLength(1);
      expect(fake.calls.filter((call) => call.startsWith('compare'))).toHaveLength(1);
    });

    it('fills ownRunId when the branch belongs to one of our runs', async () => {
      await link(projectA);
      const task = await AgentTask.create({
        projectId: projectA, externalId: 'local:1', title: 'фича', status: 'new', priority: 'normal',
      } as any);
      const run = await AgentRun.create({
        taskId: task.id, projectId: projectA, status: 'succeeded', trigger: 'manual',
        pipelineSnapshot: { stages: [] }, currentStageIndex: 0, branch: 'agentiz/x',
      } as any);

      fake.branches = [{ name: 'agentiz/x', commit: { sha: 'aaa' } }];
      await poll();
      await advanceActivity();

      fake.branches = [{ name: 'agentiz/x', commit: { sha: 'bbb' } }];
      fake.comparisons.set('aaa...bbb', { status: 'ahead', html_url: 'https://c', commits: [] });
      const seen = collect<AgentizRepositoryPushedPayload>(AGENTIZ_REPOSITORY_PUSHED);

      await poll();

      expect(seen[0].ownRunId).toBe(run.id);
      expect(seen[0].ownTaskId).toBe(task.id);
    });

    it('skips a repository GitHub says nothing happened in, without a single API call', async () => {
      await link(projectA);
      fake.branches = [{ name: 'main', commit: { sha: 'aaa' } }];
      await poll();
      // `lastActivityAt` mirrors GitHub's `pushed_at` and is refreshed by the repository sync that
      // runs earlier in the same tick; older than the cursor means nothing to ask about.
      await repository.update({ lastActivityAt: new Date(Date.now() - 3600_000) });
      fake.calls.length = 0;

      const result = await poll();

      expect(result.skipped).toBe('idle');
      expect(fake.calls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // installing the hook
  // -------------------------------------------------------------------------

  describe('the hook we install', () => {
    beforeEach(() => {
      registerGitConnectionAuthority(githubConnectionAuthority);
      registerWebhookHost(host());
    });

    afterEach(() => {
      unregisterGitConnectionAuthority('github');
      unregisterWebhookHost();
    });

    it('installs on the first project link and pings it', async () => {
      await link(projectA);
      await syncRepositoryWebhook(repository.id);

      await repository.reload();
      expect(fake.created).toHaveLength(1);
      // *Which* events is asserted by the test below; here it only matters that it asked for some.
      expect(fake.created[0].events).toContain('push');
      expect(repository.webhook?.hookId).toBe('555');
      expect(repository.webhook?.secret).toHaveLength(64);
      expect(repository.webhook?.lastError).toBeNull();
      // "хук создан" is not "хук доставляется"; the ping is what makes an unreachable server fail
      // here rather than at the first real push.
      expect(fake.pinged).toEqual(['555']);
    });

    it('asks for the three facts the core has events for', async () => {
      await link(projectA);
      await syncRepositoryWebhook(repository.id);

      expect(fake.created[0].events).toEqual(['push', 'workflow_run', 'package']);
      await repository.reload();
      expect(repository.webhook?.events).toEqual(['push', 'workflow_run', 'package']);
    });

    it('upgrades a hook installed before an event was added, keeping its id and secret', async () => {
      await link(projectA);
      await syncRepositoryWebhook(repository.id);
      await repository.reload();
      const { hookId, secret } = repository.webhook!;
      // Exactly the shape a repository linked before `package` was watched has on disk: installed,
      // reachable, and either missing the field entirely or carrying the older set.
      await repository.update({ webhook: { ...repository.webhook, events: ['push', 'workflow_run'] } });
      fake.calls.length = 0;

      await syncRepositoryWebhook(repository.id);

      expect(fake.updated).toEqual([{ hookId: hookId!, events: ['push', 'workflow_run', 'package'] }]);
      // Not reinstalled: a new secret would leave a delivery in flight unverifiable.
      expect(fake.calls).not.toContain('createHook');
      expect(fake.calls).not.toContain('deleteHook');
      await repository.reload();
      expect(repository.webhook?.hookId).toBe(hookId);
      expect(repository.webhook?.secret).toBe(secret);
      expect(repository.webhook?.events).toEqual(['push', 'workflow_run', 'package']);
    });

    it('the poll pass reconciles a hook nobody has touched since it was installed', async () => {
      await link(projectA);
      await syncRepositoryWebhook(repository.id);
      await repository.reload();
      // The state of a repository linked before `package` was watched: nothing writes its link
      // again, so only the poll can notice.
      await repository.update({ webhook: { ...repository.webhook, events: ['push', 'workflow_run'] } });
      fake.branches = [{ name: 'main', commit: { sha: 'aaa' } }];

      await GithubRepositoryEventService.pollAll();

      await repository.reload();
      expect(repository.webhook?.events).toEqual(['push', 'workflow_run', 'package']);
    });

    it('is a no-op once installed — the common path costs no API call', async () => {
      await link(projectA);
      await syncRepositoryWebhook(repository.id);
      await repository.reload();
      fake.calls.length = 0;

      await syncRepositoryWebhook(repository.id);

      expect(fake.calls).toHaveLength(0);
    });

    it('comes down when the last link goes away, and takes the endpoint with it', async () => {
      const only = await link(projectA);
      await syncRepositoryWebhook(repository.id);
      await repository.reload();

      await only.destroy();
      await syncRepositoryWebhook(repository.id);

      await repository.reload();
      expect(fake.deleted).toEqual(['555']);
      expect(repository.webhook).toBeNull();
      expect(await AgentWebhookEndpoint.count()).toBe(0);
    });

    it('degrades to the poll when the connection lost the scope, and says why', async () => {
      await connection.update({ scope: 'read:user' });

      await link(projectA);
      await syncRepositoryWebhook(repository.id);

      await repository.reload();
      expect(fake.created).toHaveLength(0);
      expect(repository.webhook?.hookId).toBeFalsy();
      expect(repository.webhook?.lastError).toMatch(/скоуп/);

      // And the poll keeps working on exactly that repository — the whole point of degrading.
      fake.branches = [{ name: 'main', commit: { sha: 'aaa' } }];
      const result = await poll();
      expect(result.seeded).toBe(true);
    });

    it('degrades when there is nowhere to receive deliveries at all', async () => {
      unregisterWebhookHost();

      await link(projectA);
      await syncRepositoryWebhook(repository.id);

      await repository.reload();
      expect(fake.created).toHaveLength(0);
      expect(repository.webhook?.lastError).toMatch(/не смонтирован/);
    });

    it('follows the project links by itself: linking installs, unlinking removes', async () => {
      const first = await link(projectA);
      const second = await link(projectB);
      await settled();
      await repository.reload();
      expect(repository.webhook?.hookId).toBe('555');

      // One project letting go is not the last one — the other still shares this delivery.
      await first.destroy();
      await settled();
      await repository.reload();
      expect(repository.webhook?.hookId).toBe('555');

      await second.destroy();
      await settled();
      await repository.reload();
      expect(repository.webhook).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // receiving a delivery
  // -------------------------------------------------------------------------

  describe('a delivery from GitHub', () => {
    let server: ReturnType<express.Express['listen']>;
    let base: string;
    let endpointId: string;
    let secret: string;

    beforeEach(async () => {
      registerWebhookMapper(githubRepositoryWebhookMapper);
      registerWebhookHost(host());
      registerGitConnectionAuthority(githubConnectionAuthority);
      await link(projectA);
      await syncRepositoryWebhook(repository.id);
      await repository.reload();
      endpointId = repository.webhook!.endpointId!;
      secret = repository.webhook!.secret!;

      const app = express();
      app.use('/api/agentiz/hooks/v1', createWebhookRouter());
      await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agentiz/hooks/v1`;
    });

    afterEach(async () => {
      unregisterWebhookMapper(githubRepositoryWebhookMapper.kind);
      unregisterWebhookHost();
      unregisterGitConnectionAuthority('github');
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    async function deliver(
      event: string,
      body: unknown,
      options: { delivery?: string; signWith?: string } = {},
    ): Promise<Response> {
      const raw = JSON.stringify(body);
      const signature = `sha256=${createHmac('sha256', options.signWith ?? secret).update(raw).digest('hex')}`;
      return fetch(`${base}/${endpointId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': event,
          'X-GitHub-Delivery': options.delivery ?? `d-${Math.random()}`,
          'X-Hub-Signature-256': signature,
        },
        body: raw,
      });
    }

    const pushBody = (patch: Record<string, unknown> = {}) => ({
      ref: 'refs/heads/main',
      before: 'aaa',
      after: 'bbb',
      forced: false,
      compare: 'https://compare',
      commits: [{ id: 'bbb', message: 'fix', url: 'https://c', author: { username: 'ann' } }],
      ...patch,
    });

    it('a signed push becomes an event and moves the cursor', async () => {
      const seen = collect<AgentizRepositoryPushedPayload>(AGENTIZ_REPOSITORY_PUSHED);

      const res = await deliver('push', pushBody());

      expect(res.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0].branch).toBe('main');
      expect(seen[0].afterSha).toBe('bbb');
      expect(seen[0].commits[0].author).toBe('ann');
      await repository.reload();
      expect(watchCursorOf(repository).branchHeads.main).toBe('bbb');
      // The fast path carries its commits in the delivery — `/compare` is never called.
      expect(fake.calls.filter((call) => call.startsWith('compare'))).toHaveLength(0);
    });

    it('and the poll then says nothing about that same push — one cursor, two sources', async () => {
      await deliver('push', pushBody());
      const seen = collect<unknown>(AGENTIZ_REPOSITORY_PUSHED);
      fake.branches = [{ name: 'main', commit: { sha: 'bbb' } }];

      const result = await poll();

      expect(result.pushes).toBe(0);
      expect(seen).toHaveLength(0);
    });

    it('a bad signature is 401 with nothing published and nothing in the feed', async () => {
      const seen = collect<unknown>(AGENTIZ_REPOSITORY_PUSHED);

      const res = await deliver('push', pushBody(), { signWith: 'not-our-secret' });

      expect(res.status).toBe(401);
      expect(seen).toHaveLength(0);
      expect(await AgentActivity.count()).toBe(0);
      // Refused, but still journalled — that journal is the only answer to "мы отправили".
      const delivery = await AgentWebhookDelivery.findOne({ where: { outcome: 'rejected' } });
      expect(delivery?.httpStatus).toBe(401);
    });

    it('the same delivery id twice is 200 once and 200 again, with one event', async () => {
      const seen = collect<unknown>(AGENTIZ_REPOSITORY_PUSHED);

      const first = await deliver('push', pushBody(), { delivery: 'same' });
      const second = await deliver('push', pushBody(), { delivery: 'same' });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ duplicate: true });
      expect(seen).toHaveLength(1);
    });

    it('a ping is 200 and complete silence', async () => {
      const seen = collect<unknown>(AGENTIZ_REPOSITORY_PUSHED);

      const res = await deliver('ping', { zen: 'Anything added dilutes everything else.' });

      expect(res.status).toBe(200);
      expect(seen).toHaveLength(0);
      const delivery = await AgentWebhookDelivery.findOne({ where: { outcome: 'ignored' } });
      expect(delivery?.detail).toMatch(/ping/);
    });

    it('a completed workflow_run becomes a CI event; a started one does not', async () => {
      const seen = collect<AgentizRepositoryCiRunPayload>(AGENTIZ_REPOSITORY_CI_RUN);

      await deliver('workflow_run', {
        action: 'requested',
        workflow_run: { id: 1, name: 'CI', head_branch: 'main', head_sha: 'bbb', conclusion: null, html_url: 'https://r/1' },
      });
      await deliver('workflow_run', {
        action: 'completed',
        workflow_run: { id: 2, name: 'CI', head_branch: 'main', head_sha: 'bbb', conclusion: 'failure', html_url: 'https://r/2' },
      });

      expect(seen).toHaveLength(1);
      expect(seen[0].conclusion).toBe('failure');
      expect(seen[0].externalRunId).toBe('2');
    });

    it('a deleted branch drops its head and publishes nothing', async () => {
      await deliver('push', pushBody());
      const seen = collect<unknown>(AGENTIZ_REPOSITORY_PUSHED);

      await deliver('push', pushBody({ deleted: true, after: '0000000000000000000000000000000000000000' }));

      expect(seen).toHaveLength(0);
      await repository.reload();
      expect(watchCursorOf(repository).branchHeads.main).toBeUndefined();
    });

    const packageBody = (patch: Record<string, unknown> = {}) => ({
      action: 'published',
      package: {
        name: 'hello',
        package_type: 'CONTAINER',
        namespace: 'octocat',
        html_url: 'https://github.com/octocat/hello/pkgs/container/hello',
        package_version: {
          version: 'sha256:beef',
          name: 'sha256:beef',
          package_url: 'ghcr.io/octocat/hello',
          html_url: 'https://github.com/octocat/hello/pkgs/container/hello/1',
          container_metadata: { tag: { name: 'v1.2.3', digest: 'sha256:beef' } },
        },
      },
      ...patch,
    });

    it('a published container version becomes a package event', async () => {
      const seen = collect<AgentizRepositoryPackagePayload>(AGENTIZ_REPOSITORY_PACKAGE);

      const res = await deliver('package', packageBody());

      expect(res.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        packageName: 'hello',
        packageType: 'container',
        namespace: 'octocat',
        action: 'published',
        tag: 'v1.2.3',
        digest: 'sha256:beef',
        packageUrl: 'ghcr.io/octocat/hello',
        projectId: projectA,
        repositoryId: repository.id,
      });
      // No branch on an image, therefore no attribution — absent, not null, so that a node reading
      // `taskId` cannot mistake it for a task it failed to load.
      expect('taskId' in seen[0]).toBe(false);
      expect(await AgentActivity.count({ where: { type: 'repository.package' } })).toBe(1);
    });

    it('leaves the cursor alone: this fact has one source, so there is nobody to keep quiet', async () => {
      await deliver('push', pushBody());
      await repository.reload();
      const before = JSON.stringify(watchCursorOf(repository));

      await deliver('package', packageBody());

      await repository.reload();
      expect(JSON.stringify(watchCursorOf(repository))).toBe(before);
    });

    it('accepts the legacy registry_package spelling of the same delivery', async () => {
      const seen = collect<AgentizRepositoryPackagePayload>(AGENTIZ_REPOSITORY_PACKAGE);

      const res = await deliver('registry_package', packageBody());

      expect(res.status).toBe(200);
      expect(seen).toHaveLength(1);
    });

    it('ignores a package action that is not a version appearing or moving', async () => {
      const seen = collect<unknown>(AGENTIZ_REPOSITORY_PACKAGE);

      const res = await deliver('package', packageBody({ action: 'deleted' }));

      expect(res.status).toBe(200);
      expect(seen).toHaveLength(0);
      const delivery = await AgentWebhookDelivery.findOne({ where: { eventName: 'package' } });
      expect(delivery?.outcome).toBe('ignored');
    });

    it('a non-container package arrives with an empty tag rather than a guessed one', async () => {
      const seen = collect<AgentizRepositoryPackagePayload>(AGENTIZ_REPOSITORY_PACKAGE);

      await deliver('package', {
        action: 'published',
        package: {
          name: 'hello-sdk', package_type: 'NPM', namespace: 'octocat',
          package_version: { version: '1.4.0', name: '1.4.0', package_url: 'npm.pkg.github.com/hello-sdk' },
        },
      });

      expect(seen[0]).toMatchObject({ packageType: 'npm', version: '1.4.0', tag: '', digest: '' });
    });

    it('one repository in two projects yields one package event per project', async () => {
      await link(projectB);
      const seen = collect<AgentizRepositoryPackagePayload>(AGENTIZ_REPOSITORY_PACKAGE);

      await deliver('package', packageBody());

      expect(seen.map((item) => item.projectId).sort()).toEqual([projectA, projectB].sort());
    });

    it('an event we never asked for is journalled as ignored, not refused', async () => {
      const res = await deliver('issues', { action: 'opened' });

      expect(res.status).toBe(200);
      const delivery = await AgentWebhookDelivery.findOne({ where: { eventName: 'issues' } });
      expect(delivery?.outcome).toBe('ignored');
      expect(delivery?.detail).toMatch(/не отслеживается/);
    });

    it('an unknown endpoint is 404, telling a stranger nothing', async () => {
      const res = await fetch(`${base}/00000000-0000-0000-0000-000000000000`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(404);
    });
  });

  /** The receiving layer's host, as the real one behaves with a public URL configured. */
  function host() {
    const origin = 'https://agentiz.example';
    const path = '/api/agentiz/hooks/v1';
    return {
      ensureEndpoint: async (input: any) => {
        const [endpoint] = await AgentWebhookEndpoint.findOrCreate({
          where: { ownerKey: input.ownerKey },
          defaults: {
            kind: input.kind, ownerKey: input.ownerKey, projectId: input.projectId ?? null,
            config: input.config ?? null, secretHash: null, isActive: true,
          } as any,
        });
        return { id: endpoint.id, url: `${origin}${path}/${endpoint.id}` };
      },
      removeEndpoint: async (ownerKey: string) => {
        const endpoint = await AgentWebhookEndpoint.findOne({ where: { ownerKey } });
        if (endpoint) await endpoint.destroy();
      },
      endpointUrl: (id: string) => `${origin}${path}/${id}`,
    };
  }

  /**
   * The idle filter compares `lastActivityAt` to the cursor, so a test that polls twice in the same
   * millisecond has to say the repository moved — otherwise the second pass is legitimately skipped.
   */
  async function advanceActivity(): Promise<void> {
    await repository.reload();
    await repository.update({ lastActivityAt: new Date(Date.now() + 60_000) });
  }
});

/**
 * The model hooks that keep the webhook in step with the links are fire-and-forget: the link row's
 * `afterCommit` schedules the reconciliation and returns long before the platform answers.
 *
 * Waited for by the barrier that reconciliation registers itself with (`lib/detachedWork.ts`) and
 * not by a duration — 50 ms was a bet on an idle machine, and under a full suite run this file
 * started reading `webhook.hookId` before the hook it asserts had been installed.
 */
const settled = (): Promise<void> => detachedWorkSettled();
