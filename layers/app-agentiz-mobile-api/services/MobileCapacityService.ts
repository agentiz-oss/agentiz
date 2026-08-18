import { Op } from 'sequelize';
import { AgentHarnessSubscription } from '../../app-agentiz/models/AgentHarnessSubscription';
import { AgentRunJob } from '../../app-agentiz/models/AgentRunJob';
import { AgentWorker } from '../../app-agentiz/models/AgentWorker';
import { AgentWorkerHarness } from '../../app-agentiz/models/AgentWorkerHarness';
import { subscriptionView, workerHarnessView } from '../../app-agentiz/lib/capacityViews';
import type { HarnessWindowState } from '../../app-agentiz/types/agentiz';

/** A worker's harness as one row of the phone's list, and one card of the subscriptions tab. */
export interface MobileHarnessWindow {
  key: string;
  label: string | null;
  usedPercent: number | null;
  resetsAt: string | null;
  observedAt: string | null;
  source: string | null;
}

/**
 * The read side of the capacity subsystem for the phone.
 *
 * Everything comes out of `app-agentiz/lib/capacityViews` — the same views the admin panel and the
 * MCP tools read — so "какой лимит у воркера" cannot mean one thing on the dashboard and another in
 * the app. What this service adds is only shaping: the app renders windows as bars and needs one
 * flat, always-present list per harness, whereas the view passes provider `meta` through untouched
 * and leaves the caller to decide which snapshot is the current one.
 *
 * Scope is deliberately *not* the caller's projects, unlike the rest of this layer: a worker and a
 * subscription belong to the installation, not to a project owner, and there is nothing secret in
 * them — a subscription holds a name, a policy and percentages, never a credential (those stay on
 * the worker machine).
 */
export class MobileCapacityService {
  /**
   * The windows to show for one harness, newest observation first choice: the worker's own last
   * sample when it has one, otherwise the subscription's cached snapshot.
   *
   * The two normally agree — the sample is what wrote the subscription — but a worker that has not
   * reported since its sibling did would otherwise show its sibling's numbers as its own.
   */
  private static windowsOf(
    sample: { windows?: unknown; observedAt?: unknown; source?: unknown } | null,
    subscription: { windows?: unknown } | null,
  ): MobileHarnessWindow[] {
    const raw = (Array.isArray(sample?.windows) && sample!.windows.length > 0
      ? sample!.windows
      : Array.isArray(subscription?.windows)
        ? subscription!.windows
        : []) as HarnessWindowState[];
    return raw.map((window) => ({
      key: String(window.key ?? ''),
      label: window.label ?? null,
      usedPercent: typeof window.usedPercent === 'number' ? window.usedPercent : null,
      resetsAt: window.resetsAt ? String(window.resetsAt) : null,
      observedAt: window.observedAt ? String(window.observedAt) : null,
      source: window.source ?? null,
    }));
  }

  /** One worker with every harness bound to it — the shape both `/workers` and `/workers/:id` use. */
  private static async describeWorker(worker: AgentWorker) {
    const harnesses = (await workerHarnessView(worker)) as Array<Record<string, any>>;
    return {
      id: worker.id,
      name: worker.name,
      status: worker.status,
      contactState: worker.contactState(),
      lastSeenAt: worker.lastSeenAt,
      version: worker.version,
      hostname: worker.hostname,
      maxConcurrentJobs: worker.effectiveMaxConcurrentJobs(),
      activeHours: worker.activeHours,
      timezone: worker.timezone,
      harnesses: harnesses.map((harness) => ({
        id: String(harness.id),
        harnessKey: String(harness.harnessKey),
        enabled: Boolean(harness.enabled),
        // 'disabled' | 'exhausted' | 'available', decided by the shared view — the app colours the
        // row from it and never re-derives "исчерпан" out of the percentages.
        state: String(harness.state),
        maxConcurrent: harness.maxConcurrent ?? null,
        runningJobs: Number(harness.runningJobs ?? 0),
        queuedJobs: Number(harness.queuedJobs ?? 0),
        accountMismatch: Boolean(harness.accountMismatch),
        observedAt: harness.latestSample?.observedAt ?? null,
        subscription: harness.subscription
          ? {
              id: String(harness.subscription.id),
              name: String(harness.subscription.name),
              provider: harness.subscription.provider ?? null,
              authKind: harness.subscription.authKind ?? null,
              exhausted: Boolean(harness.subscription.exhausted),
              exhaustedUntil: harness.subscription.exhaustedUntil ?? null,
              exhaustedReason: harness.subscription.exhaustedReason ?? null,
            }
          : null,
        windows: this.windowsOf(harness.latestSample ?? null, harness.subscription ?? null),
      })),
    };
  }

  /** Every worker the installation still has, revoked ones excluded, name order. */
  static async workers() {
    const workers = await AgentWorker.findAll({
      where: { status: { [Op.ne]: 'revoked' } },
      order: [['name', 'ASC']],
    });
    return Promise.all(workers.map((worker) => this.describeWorker(worker)));
  }

  /** One worker by id, or null — a revoked one is still readable here, unlike in the list. */
  static async worker(workerId: string) {
    const worker = await AgentWorker.findByPk(workerId);
    if (!worker) return null;
    return this.describeWorker(worker);
  }

  /**
   * The subscriptions tab: one card per account, with its limit windows and the workers that spend
   * it. Two workers on one subscription exhaust together, which is exactly why the tab exists next
   * to the per-worker list rather than instead of it.
   */
  static async subscriptions() {
    const subscriptions = await AgentHarnessSubscription.findAll({ order: [['name', 'ASC']] });
    if (subscriptions.length === 0) return [];

    const bindings = await AgentWorkerHarness.findAll({
      where: { subscriptionId: { [Op.in]: subscriptions.map((subscription) => subscription.id) } },
    });
    const workers = await AgentWorker.findAll({
      where: { id: { [Op.in]: [...new Set(bindings.map((binding) => binding.workerId))] } },
    });
    const workerById = new Map(workers.map((worker) => [worker.id, worker]));
    const activeJobs = await AgentRunJob.findAll({
      where: { status: { [Op.in]: ['leased', 'running'] } },
      attributes: ['workerId', 'harnessKey'],
    });

    return subscriptions.map((subscription) => {
      const view = subscriptionView(subscription);
      const mine = bindings.filter((binding) => binding.subscriptionId === subscription.id);
      return {
        id: view.id,
        name: view.name,
        provider: view.provider,
        authKind: view.authKind,
        notes: view.notes,
        accountId: view.accountId,
        stopPolicy: view.stopPolicy,
        resetSchedule: view.resetSchedule,
        exhausted: view.exhausted,
        exhaustedUntil: view.exhaustedUntil,
        exhaustedReason: view.exhaustedReason,
        lastSignalAt: view.lastSignalAt,
        lastSignalSource: view.lastSignalSource,
        windows: this.windowsOf(null, view),
        workers: mine.map((binding) => {
          const worker = workerById.get(binding.workerId);
          return {
            id: binding.workerId,
            name: worker?.name ?? binding.workerId,
            harnessKey: binding.harnessKey,
            enabled: binding.enabled,
            contactState: worker?.contactState() ?? 'never_contacted',
            runningJobs: activeJobs.filter(
              (job) => job.workerId === binding.workerId && job.harnessKey === binding.harnessKey,
            ).length,
          };
        }),
      };
    });
  }
}
