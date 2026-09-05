import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
  // Pulled in through the dashboard-notification seam; a class body is all the import needs.
  AbstractNotificationService: class {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../models';
import { AgentHarnessSubscription } from '../models/AgentHarnessSubscription';
import { AgentProject } from '../models/AgentProject';
import { AgentRun } from '../models/AgentRun';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentTask } from '../models/AgentTask';
import { AgentWorker } from '../models/AgentWorker';
import { AgentWorkerHarness } from '../models/AgentWorkerHarness';
import { registerHarnessLimitProvider, unregisterHarnessLimitProvider } from '../lib/harnessLimits';
import { AgentCapacityService } from './AgentCapacityService';
import { AgentJobClaimService } from './AgentJobClaimService';
import { AgentRunDeferService } from './AgentRunDeferService';

const CLAUDE_STAGE_AGENT = { kind: 'openhands-acp', config: { acpCommand: ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.66.0'] } };

describe('harness capacity: gates, deferral and recovery', () => {
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
      projectId: project.id, taskId: task.id, status: 'running', trigger: 'manual', currentStageIndex: 0,
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

  it('does not hand a gated harness to a closed subscription, but another worker takes the job', async () => {
    const closed = await makeWorker('closed');
    const open = await makeWorker('open');
    const subscription = await AgentHarnessSubscription.create({
      name: 'Claude Max', provider: 'anthropic', exhaustedUntil: new Date(Date.now() + 60 * 60_000),
    } as any);
    await AgentWorkerHarness.create({ workerId: closed.id, harnessKey: 'claude', subscriptionId: subscription.id } as any);
    const { job } = await makeRunAndJob();

    expect((await claim(closed)).job).toBeNull();
    const taken = await claim(open);
    expect(taken.job?.id).toBe(job.id);
  });

  it('blocks a mixed job when any of its keys is gated', async () => {
    const worker = await makeWorker('w');
    const subscription = await AgentHarnessSubscription.create({
      name: 'S', provider: 'anthropic', exhaustedUntil: new Date(Date.now() + 60 * 60_000),
    } as any);
    await AgentWorkerHarness.create({ workerId: worker.id, harnessKey: 'claude', subscriptionId: subscription.id } as any);
    await makeRunAndJob({ harnessKey: 'mixed', snapshot: { stages: [], harnessKeys: ['codex', 'claude'] } });

    expect((await claim(worker)).job).toBeNull();
  });

  it('still hands out git-only jobs (harnessKey NULL) under a closed gate', async () => {
    const worker = await makeWorker('w');
    const subscription = await AgentHarnessSubscription.create({
      name: 'S', provider: 'anthropic', exhaustedUntil: new Date(Date.now() + 60 * 60_000),
    } as any);
    await AgentWorkerHarness.create({ workerId: worker.id, harnessKey: 'claude', subscriptionId: subscription.id } as any);
    const { job } = await makeRunAndJob({ harnessKey: null, snapshot: { stages: [] } });

    expect((await claim(worker)).job?.id).toBe(job.id);
  });

  it('enforces maxConcurrentJobs against jobs already held', async () => {
    const worker = await makeWorker('w', { maxConcurrentJobs: 1 });
    await makeRunAndJob({ status: 'running', workerId: worker.id, harnessKey: null });
    await makeRunAndJob();
    expect((await claim(worker)).job).toBeNull();

    await worker.update({ maxConcurrentJobs: 2 });
    expect((await claim(worker)).job).not.toBeNull();
  });

  it('refuses to claim while the machine itself is outside its active hours', async () => {
    const worker = await makeWorker('w', {
      activeHours: { timezone: 'UTC', windows: [{ days: ['mon'], start: '00:00', end: '00:01' }] },
    });
    await makeRunAndJob();
    const outcome = await claim(worker);
    expect(outcome.job).toBeNull();
    expect(outcome.nextEligibleAt).toBeInstanceOf(Date);
  });

  it('heals a job whose schedule window closed instead of handing it out', async () => {
    const worker = await makeWorker('w');
    const closedWindow = { timezone: 'UTC', windows: [{ days: ['mon'], start: '00:00', end: '00:01' }] };
    const { job } = await makeRunAndJob({ scheduleWindow: closedWindow });

    expect((await claim(worker)).job).toBeNull();
    await job.reload();
    expect(job.deferReason).toBe('schedule_window');
    expect(job.availableAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('defers a classified limit failure: gate closes, attempt is refunded, run waits, recovery wakes it', async () => {
    registerHarnessLimitProvider({
      id: 'test:claude',
      handles: (key) => key === 'claude',
      declareWindows: () => [{ key: '5h', label: '5h' }],
      classifyFailure: (text) => (text.includes('usage limit')
        ? { kind: 'exhausted', windowKey: '5h', resumeAt: new Date(Date.now() + 2 * 60 * 60_000), matched: 'test-pattern' }
        : null),
    });
    try {
      const worker = await makeWorker('w');
      const { run, job } = await makeRunAndJob({ requiredWorkerId: worker.id, status: 'running', workerId: worker.id, attempt: 1 });

      const classified = await AgentRunDeferService.classify(job, worker, 'Claude usage limit reached', []);
      expect(classified?.harnessKey).toBe('claude');
      const { retryAt, exhaustedUntil } = await AgentRunDeferService.defer({
        job, run, worker, classified: classified!, errorText: 'Claude usage limit reached',
      });

      await job.reload();
      await run.reload();
      expect(job.status).toBe('released');
      expect(job.deferReason).toBe('harness_limit');
      expect(job.deferredCount).toBe(1);
      expect(job.attempt).toBe(0); // the claim's increment came back
      expect(job.availableAt.getTime()).toBe(retryAt.getTime());
      expect(retryAt.getTime()).toBeGreaterThan(Date.now() + 60 * 60_000); // pinned ⇒ waits for the reset
      expect(run.status).toBe('running'); // deliberately not a terminal status
      expect(run.waitingReason).toBe('harness_limit');

      // The implicit subscription was auto-created and closed.
      const binding = await AgentWorkerHarness.findOne({ where: { workerId: worker.id, harnessKey: 'claude' } });
      const subscription = await AgentHarnessSubscription.findByPk(binding!.subscriptionId!);
      expect(subscription!.isExhausted()).toBe(true);
      expect(subscription!.exhaustedUntil!.getTime()).toBe(exhaustedUntil.getTime());
      expect((await AgentCapacityService.gatedHarnessKeys(worker)).includes('claude')).toBe(true);

      // Early recovery wakes the pinned job instead of letting it sleep until the old forecast.
      await AgentCapacityService.clearLimit(subscription!.id, 'tokens arrived early');
      await job.reload();
      expect(job.availableAt.getTime()).toBeLessThanOrEqual(Date.now());
      AgentCapacityService.invalidateGateCache();
      expect((await AgentCapacityService.gatedHarnessKeys(worker)).includes('claude')).toBe(false);
    } finally {
      unregisterHarnessLimitProvider('test:claude');
    }
  });

  it('closes the gate preventively from a stopPolicy threshold and reopens when telemetry drops', async () => {
    const worker = await makeWorker('w');
    const subscription = await AgentHarnessSubscription.create({
      name: 'S', provider: 'anthropic', stopPolicy: { weekly: { pauseAtUsedPercent: 80 } },
    } as any);
    await AgentWorkerHarness.create({ workerId: worker.id, harnessKey: 'claude', subscriptionId: subscription.id } as any);

    const resetsAt = new Date(Date.now() + 3 * 24 * 60 * 60_000);
    await AgentCapacityService.applySnapshot({
      workerId: worker.id, harnessKey: 'claude', source: 'report',
      snapshot: { windows: [{ key: 'weekly', label: 'weekly', usedPercent: 85, resetsAt }] },
    });
    await subscription.reload();
    expect(subscription.isExhausted()).toBe(true);
    expect(subscription.exhaustedReason).toMatch(/^Preventive stop/);

    await AgentCapacityService.applySnapshot({
      workerId: worker.id, harnessKey: 'claude', source: 'report',
      snapshot: { windows: [{ key: 'weekly', label: 'weekly', usedPercent: 10, resetsAt }] },
    });
    await subscription.reload();
    expect(subscription.isExhausted()).toBe(false);
  });

  it('interprets a raw report through the harness provider and rejects one nobody understands', async () => {
    const worker = await makeWorker('w');
    registerHarnessLimitProvider({
      id: 'test:claude',
      handles: (key) => key === 'claude',
      declareWindows: () => [{ key: '5h', label: '5h' }],
      classifyFailure: () => null,
      interpretReport: (raw) => {
        const source = raw as Record<string, { utilization?: number; resets_at?: string }>;
        const window = source.five_hour;
        if (!window) return null;
        return { windows: [{ key: '5h', label: '5h', usedPercent: window.utilization, resetsAt: window.resets_at ? new Date(window.resets_at) : null }] };
      },
    });
    try {
      const resetsAt = new Date(Date.now() + 60 * 60_000);
      const { subscription, sample } = await AgentCapacityService.applyReport({
        workerId: worker.id,
        harnessKey: 'claude',
        raw: { five_hour: { utilization: 37, resets_at: resetsAt.toISOString() } },
      });
      // The worker sends provider vocabulary; only the core's abstract window reaches the database.
      expect(sample.source).toBe('report');
      expect(subscription?.windows?.[0]).toMatchObject({ key: '5h', usedPercent: 37 });
      // A binding is created by the report itself, exactly as a limit signal would.
      expect(await AgentWorkerHarness.count({ where: { workerId: worker.id, harnessKey: 'claude' } })).toBe(1);

      await expect(AgentCapacityService.applyReport({
        workerId: worker.id, harnessKey: 'claude', raw: { something_else: {} },
      })).rejects.toThrow(/could not interpret/);
      await expect(AgentCapacityService.applyReport({
        workerId: worker.id, harnessKey: 'codex', raw: { five_hour: {} },
      })).rejects.toThrow(/No registered provider/);
    } finally {
      unregisterHarnessLimitProvider('test:claude');
    }
  });

  it('records what came of the window poke it asked for, and since when it has been failing', async () => {
    const worker = await makeWorker('w');
    const snapshot = { windows: [{ key: '5h', label: '5h', usedPercent: 10, resetsAt: new Date(Date.now() + 60 * 60_000).toISOString() }] };

    // A worker built before this field simply sends no poke, and the subscription keeps its shape:
    // "nothing reported" and "reported that nothing happened" must not look the same.
    const first = await AgentCapacityService.applyReport({ workerId: worker.id, harnessKey: 'claude', snapshot });
    expect(first.subscription?.lastPoke ?? null).toBeNull();

    const brokeAt = new Date(Date.now() - 40 * 60_000).toISOString();
    const failed = await AgentCapacityService.applyReport({
      workerId: worker.id, harnessKey: 'claude', snapshot,
      poke: { ok: false, at: brokeAt, error: 'no claude CLI found' },
    });
    expect(failed.subscription?.lastPoke).toMatchObject({
      ok: false, at: brokeAt, error: 'no claude CLI found', failedSince: brokeAt, workerId: worker.id,
    });

    // Every repeat keeps the streak's start: a reader needs "broken since", not the latest of many.
    const again = new Date().toISOString();
    const repeated = await AgentCapacityService.applyReport({
      workerId: worker.id, harnessKey: 'claude', snapshot, poke: { ok: false, at: again, error: 'no claude CLI found' },
    });
    expect(repeated.subscription?.lastPoke).toMatchObject({ at: again, failedSince: brokeAt });

    const recovered = await AgentCapacityService.applyReport({
      workerId: worker.id, harnessKey: 'claude', snapshot, poke: { ok: true, at: again },
    });
    expect(recovered.subscription?.lastPoke).toMatchObject({ ok: true, error: null, failedSince: null });

    // Anything unrecognizable is not a report about a poke, and must not erase what is known.
    const garbage = await AgentCapacityService.applyReport({
      workerId: worker.id, harnessKey: 'claude', snapshot, poke: { error: 'half a payload' },
    });
    expect(garbage.subscription?.lastPoke).toMatchObject({ ok: true });
  });
});
