import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
  // Pulled in through the dashboard-notification seam; a class body is all the import needs.
  AbstractNotificationService: class {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../models';
import { AgentActivity } from '../models/AgentActivity';
import { AgentProject } from '../models/AgentProject';
import { AgentRun } from '../models/AgentRun';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentHarnessUsageSample } from '../models/AgentHarnessUsageSample';
import { AgentTask } from '../models/AgentTask';
import { AgentWorker } from '../models/AgentWorker';
import { AgentWorkerHarness } from '../models/AgentWorkerHarness';
import { registerHarnessLimitProvider, unregisterHarnessLimitProvider } from '../lib/harnessLimits';
import { workerHarnessView } from '../lib/capacityViews';
import { AgentCapacityService } from './AgentCapacityService';
import { AgentJobClaimService } from './AgentJobClaimService';
import { AgentRunDeferService } from './AgentRunDeferService';

const CLAUDE_STAGE_AGENT = { kind: 'openhands-acp', config: { acpCommand: ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.66.0'] } };

/**
 * "Нет входа" as its own state, beside the quota one.
 *
 * The bug this whole mechanism answers: a worker whose Claude credential had died kept polling
 * for jobs, the panel showed it online with an un-exhausted subscription, and a task launched
 * from the phone simply never moved — no error, no row, nothing to read. A quota gate is silent
 * on purpose (it ends by itself); this one must not be, because only a person with a browser on
 * that machine ever ends it.
 *
 * The three properties the tests below hold down: an installation nobody reports a credential for
 * behaves exactly as it did before the column existed; a machine that says it is logged out stops
 * receiving that harness's work and *says so* once per parked run; and the first healthy report
 * undoes all of it without anybody pressing anything.
 */
describe('harness authorization: gate, notice and recovery', () => {
  let sequelize: Sequelize;
  let project: AgentProject;
  let task: AgentTask;

  beforeAll(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, models: Object.values(agentizModels) as any[] });
  });

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    AgentCapacityService.invalidateGateCache();
    project = await AgentProject.create({ name: 'Test', slug: 'test', ownerId: 1 } as any);
    task = await AgentTask.create({ projectId: project.id, externalId: 'local:1', title: 'Fix', status: 'queued', priority: 'normal' } as any);
  });

  afterAll(async () => sequelize.close());

  async function makeWorker(name: string, extra: Record<string, unknown> = {}): Promise<AgentWorker> {
    return AgentWorker.create({ name, kind: 'external', status: 'active', ...extra } as any);
  }

  async function makeRunAndJob(extra: Record<string, unknown> = {}): Promise<{ run: AgentRun; job: AgentRunJob }> {
    const run = await AgentRun.create({
      projectId: project.id, taskId: task.id, status: 'queued', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
    } as any);
    const job = await AgentRunJob.create({
      runId: run.id, projectId: project.id, jobKind: 'pipeline', status: 'queued',
      priority: 100, attempt: 0, availableAt: new Date(Date.now() - 1000),
      snapshot: { stages: [{ executionId: 'e1', agent: CLAUDE_STAGE_AGENT }], harnessKeys: ['claude'] },
      harnessKey: 'claude',
      ...extra,
    } as any);
    return { run, job };
  }

  const claim = (worker: AgentWorker) => AgentJobClaimService.claim(worker, { mode: 'local', lockMs: 60_000, pipelineOnly: true });
  const authActivities = () => AgentActivity.findAll({ where: { type: 'harness.auth_required' } });

  it('changes nothing at all for a binding nobody has reported a credential for', async () => {
    // The state every installation is in until a worker new enough to report one shows up, and
    // the shape every row written before the column has. It must read as healthy everywhere.
    const worker = await makeWorker('legacy');
    const binding = await AgentWorkerHarness.create({ workerId: worker.id, harnessKey: 'claude' } as any);
    const { job, run } = await makeRunAndJob();

    await binding.reload();
    expect(binding.authState).toBeNull();
    expect(binding.needsLogin()).toBe(false);
    expect(await AgentCapacityService.gatedHarnessKeys(worker)).toEqual([]);
    expect((await claim(worker)).job?.id).toBe(job.id);

    await AgentCapacityService.sweepOnce();
    await run.reload();
    expect(run.waitingReason).toBeNull();
    expect(await authActivities()).toHaveLength(0);
    expect((await workerHarnessView(worker))[0]).toMatchObject({ state: 'available', authState: null });
  });

  it('takes a credential-only report, closes that machine\'s gate and stores no empty sample', async () => {
    const worker = await makeWorker('logged-out');
    const other = await makeWorker('healthy');
    await AgentWorkerHarness.create({ workerId: other.id, harnessKey: 'claude', authState: 'ok' } as any);
    const { job } = await makeRunAndJob();

    const outcome = await AgentCapacityService.applyReport({
      workerId: worker.id,
      harnessKey: 'claude',
      // No `raw`, no `snapshot`: with no live token there are no numbers to read, and this is the
      // only thing such a machine can still say.
      auth: { state: 'expired', detail: 'refresh token expired 2026-09-12 20:04 UTC' },
    });
    expect(outcome.sample).toBeNull();
    expect(await AgentHarnessUsageSample.count()).toBe(0);

    const binding = await AgentWorkerHarness.findOne({ where: { workerId: worker.id, harnessKey: 'claude' } });
    expect(binding?.authState).toBe('expired');
    expect(binding?.authDetail).toContain('refresh token expired');
    expect(binding?.authFailedSince).toBeInstanceOf(Date);
    // The binding is materialised like any other signal, subscription included.
    expect(binding?.subscriptionId).toBeTruthy();

    expect(await AgentCapacityService.gatedHarnessKeys(worker)).toEqual(['claude']);
    expect((await claim(worker)).job).toBeNull();
    // A credential belongs to a machine, not to the account: the sibling keeps working.
    expect((await claim(other)).job?.id).toBe(job.id);
  });

  it('keeps the streak start through repeated reports instead of moving it', async () => {
    const worker = await makeWorker('w');
    const first = new Date(Date.now() - 3 * 60 * 60_000);
    await AgentCapacityService.applyAuthState({
      worker, harnessKey: 'claude', state: 'expired', detail: 'not logged in', source: 'report', observedAt: first,
    });
    const repeat = await AgentCapacityService.applyAuthState({
      worker, harnessKey: 'claude', state: 'expired', detail: 'not logged in', source: 'report',
    });
    expect(repeat.changed).toBe(false);
    expect(repeat.binding?.authFailedSince?.getTime()).toBe(first.getTime());
    expect(repeat.binding?.authCheckedAt?.getTime()).toBeGreaterThan(first.getTime());
  });

  it('parks the queued run with a reason a person can read, once and not once per sweep', async () => {
    const worker = await makeWorker('worker-2');
    const { run, job } = await makeRunAndJob();
    await job.update({ requiredWorkerId: worker.id });
    await AgentCapacityService.applyAuthState({
      worker, harnessKey: 'claude', state: 'expired', detail: 'refresh token expired', source: 'report',
    });

    await AgentCapacityService.sweepOnce();
    await run.reload();
    await job.reload();
    expect(run.waitingReason).toBe('harness_auth');
    // Deliberately no deadline: nothing but a person ends this wait, and a time on the screen
    // would be a promise nobody keeps.
    expect(run.waitingUntil).toBeNull();
    expect(job.deferReason).toBe('harness_auth');

    const activities = await authActivities();
    expect(activities).toHaveLength(1);
    expect(activities[0].title).toContain('worker-2');
    expect(activities[0].body).toContain('браузер');
    expect(activities[0].taskId).toBe(task.id);

    await AgentCapacityService.sweepOnce();
    expect(await authActivities()).toHaveLength(1);
  });

  it('leaves an unpinned job alone while some other machine can still log in', async () => {
    const broken = await makeWorker('broken');
    const healthy = await makeWorker('healthy');
    await AgentWorkerHarness.create({ workerId: healthy.id, harnessKey: 'claude', authState: 'ok' } as any);
    const { run } = await makeRunAndJob();
    await AgentCapacityService.applyAuthState({
      worker: broken, harnessKey: 'claude', state: 'expired', source: 'report',
    });

    await AgentCapacityService.sweepOnce();
    await run.reload();
    // Nothing is blocked: the job is claimable by the healthy machine, so saying "задача стоит"
    // would be a lie a person would act on.
    expect(run.waitingReason).toBeNull();
    expect(await authActivities()).toHaveLength(0);
  });

  it('reopens on the first healthy report, including from a worker too old to report a credential', async () => {
    const worker = await makeWorker('w');
    const { run, job } = await makeRunAndJob();
    await job.update({ requiredWorkerId: worker.id });
    await AgentCapacityService.applyAuthState({
      worker, harnessKey: 'claude', state: 'expired', detail: 'not logged in', source: 'failure',
    });
    await AgentCapacityService.sweepOnce();
    await job.reload();
    await job.update({ availableAt: new Date(Date.now() + 60 * 60_000) });

    // An older worker sends only numbers — and reading them required the very credential a stage
    // uses, so that *is* the proof. Without this, one classified failure would gate such a
    // machine forever, since nothing else on it would ever say otherwise.
    await AgentCapacityService.applyReport({
      workerId: worker.id,
      harnessKey: 'claude',
      snapshot: { windows: [{ key: '5h', label: '5h', usedPercent: 12 }] },
    });

    const binding = await AgentWorkerHarness.findOne({ where: { workerId: worker.id, harnessKey: 'claude' } });
    expect(binding?.authState).toBe('ok');
    expect(binding?.authFailedSince).toBeNull();
    expect(await AgentCapacityService.gatedHarnessKeys(worker)).toEqual([]);
    await job.reload();
    expect(job.availableAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await claim(worker)).job?.id).toBe(job.id);
    await run.reload();
  });

  it('defers a classified auth failure instead of failing the run, and never waits on a clock', async () => {
    registerHarnessLimitProvider({
      id: 'test:claude-auth',
      handles: (key) => key === 'claude',
      declareWindows: () => [{ key: '5h', label: '5h' }],
      classifyFailure: (text) => (text.includes('Not logged in')
        ? { kind: 'auth', matched: 'test-not-logged-in' }
        : null),
    });
    try {
      const worker = await makeWorker('w');
      const { run, job } = await makeRunAndJob({ status: 'running', workerId: null, attempt: 1 });
      await run.update({ status: 'running' });
      await job.update({ requiredWorkerId: worker.id, workerId: worker.id, status: 'leased' });

      const classified = await AgentRunDeferService.classify(job, worker, 'Not logged in · Please run /login', []);
      expect(classified?.signal.kind).toBe('auth');
      const outcome = await AgentRunDeferService.defer({
        job, run, worker, classified: classified!, errorText: 'Not logged in · Please run /login',
      });
      expect(outcome.exhaustedUntil).toBeNull();

      await job.reload();
      await run.reload();
      expect(job.status).toBe('released');
      expect(job.deferReason).toBe('harness_auth');
      expect(job.attempt).toBe(0); // the claim's increment came back, as with a quota deferral
      expect(run.status).toBe('running'); // deliberately not terminal: the work is not lost
      expect(run.waitingReason).toBe('harness_auth');
      expect(run.waitingUntil).toBeNull();

      const binding = await AgentWorkerHarness.findOne({ where: { workerId: worker.id, harnessKey: 'claude' } });
      expect(binding?.authState).toBe('expired');
      expect(binding?.authDetail).toContain('Not logged in');
      // The *subscription* is untouched: nothing about this account's quota has been learned.
      expect(binding?.subscriptionId).toBeTruthy();
      const view = (await workerHarnessView(worker))[0] as Record<string, unknown>;
      expect(view.state).toBe('unauthorized');
      expect((view.subscription as { exhausted: boolean }).exhausted).toBe(false);

      // The failure already said it, so the sweep that runs 30 seconds later stays quiet.
      expect(await authActivities()).toHaveLength(1);
      await AgentCapacityService.sweepOnce();
      expect(await authActivities()).toHaveLength(1);
    } finally {
      unregisterHarnessLimitProvider('test:claude-auth');
    }
  });
});
