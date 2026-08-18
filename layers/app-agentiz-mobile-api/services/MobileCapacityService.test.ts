import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
  // Reached through capacityViews → AgentCapacityService → the dashboard-notification seam; a class
  // body is all the import needs.
  AbstractNotificationService: class {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../../app-agentiz/models';
import { AgentHarnessSubscription } from '../../app-agentiz/models/AgentHarnessSubscription';
import { AgentHarnessUsageSample } from '../../app-agentiz/models/AgentHarnessUsageSample';
import { AgentWorker } from '../../app-agentiz/models/AgentWorker';
import { AgentWorkerHarness } from '../../app-agentiz/models/AgentWorkerHarness';
import { MobileCapacityService } from './MobileCapacityService';

/**
 * What the phone is shown about limits. The two things worth pinning: a worker's numbers are its
 * own last report rather than a sibling's, and a subscription lists every worker spending it —
 * that reverse direction is the only thing the subscriptions tab adds over the worker list.
 */
describe('MobileCapacityService', () => {
  let sequelize: Sequelize;
  let subscriptionId: string;
  let reportingWorkerId: string;
  let silentWorkerId: string;

  beforeAll(async () => {
    sequelize = new Sequelize({
      dialect: 'sqlite',
      storage: ':memory:',
      logging: false,
      models: Object.values(agentizModels) as any[],
    });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    const subscription = await AgentHarnessSubscription.create({
      name: 'Claude Max',
      provider: 'anthropic',
      authKind: 'subscription',
      windows: [{ key: 'weekly', label: 'Неделя', usedPercent: 80, resetsAt: '2026-08-24T03:00:00.000Z' }],
    } as any);
    subscriptionId = subscription.id;

    const reporting = await AgentWorker.create({ name: 'alpha', status: 'active' } as any);
    const silent = await AgentWorker.create({ name: 'beta', status: 'active' } as any);
    reportingWorkerId = reporting.id;
    silentWorkerId = silent.id;

    for (const workerId of [reporting.id, silent.id]) {
      await AgentWorkerHarness.create({ workerId, harnessKey: 'claude', subscriptionId: subscription.id } as any);
    }

    await AgentHarnessUsageSample.create({
      workerId: reporting.id,
      harnessKey: 'claude',
      subscriptionId: subscription.id,
      observedAt: new Date('2026-08-18T10:00:00.000Z'),
      source: 'worker_report',
      windows: [{ key: 'weekly', label: 'Неделя', usedPercent: 42, resetsAt: '2026-08-24T03:00:00.000Z' }],
    } as any);
  });

  it('shows a worker its own sample and falls back to the subscription for one that never reported', async () => {
    const workers = await MobileCapacityService.workers();
    const reporting = workers.find((worker) => worker.id === reportingWorkerId);
    const silent = workers.find((worker) => worker.id === silentWorkerId);

    expect(reporting?.harnesses[0].windows[0].usedPercent).toBe(42);
    // Not 42: the sibling's report says nothing about this machine's own account state.
    expect(silent?.harnesses[0].windows[0].usedPercent).toBe(80);
    expect(reporting?.harnesses[0].state).toBe('available');
    expect(reporting?.harnesses[0].subscription?.name).toBe('Claude Max');
  });

  it('reports an exhausted subscription as the gate state on every worker bound to it', async () => {
    await AgentHarnessSubscription.update(
      { exhaustedUntil: new Date(Date.now() + 60 * 60 * 1000), exhaustedReason: 'weekly limit' },
      { where: { id: subscriptionId } },
    );

    const workers = await MobileCapacityService.workers();
    expect(workers.map((worker) => worker.harnesses[0].state)).toEqual(['exhausted', 'exhausted']);

    const [subscription] = await MobileCapacityService.subscriptions();
    expect(subscription.exhausted).toBe(true);
    expect(subscription.exhaustedReason).toBe('weekly limit');
    // The reverse direction: which machines stop when this account runs out.
    expect(subscription.workers.map((worker) => worker.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('answers null for an unknown worker rather than an empty one', async () => {
    expect(await MobileCapacityService.worker('nope')).toBeNull();
  });
});
