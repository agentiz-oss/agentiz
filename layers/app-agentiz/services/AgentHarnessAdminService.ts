import { AgentHarnessSubscription } from '../models/AgentHarnessSubscription';
import { AgentWorker } from '../models/AgentWorker';
import { AgentWorkerHarness } from '../models/AgentWorkerHarness';
import { isValidTimezone, parseHhMm } from '../lib/activeHours';
import type { ActiveHoursSchedule } from '../lib/activeHours';
import type { HarnessResetSchedule, HarnessStopPolicy, HarnessSubscriptionAuthKind, HarnessSubscriptionProvider } from '../types/agentiz';
import { AgentCapacityService } from './AgentCapacityService';

export class HarnessAdminError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HarnessAdminError';
  }
}

export interface HarnessBindingInput {
  harnessKey: string;
  subscriptionId?: string | null;
  enabled?: boolean;
  maxConcurrent?: number | null;
}

export interface WorkerLimitsInput {
  maxConcurrentJobs?: number | null;
  activeHours?: ActiveHoursSchedule | null;
  timezone?: string | null;
}

export interface SubscriptionInput {
  name?: string;
  provider?: HarnessSubscriptionProvider;
  authKind?: HarnessSubscriptionAuthKind | null;
  notes?: string | null;
  resetSchedule?: HarnessResetSchedule | null;
  stopPolicy?: HarnessStopPolicy | null;
  alignResetEnabled?: boolean;
  alignResetHour?: number | null;
  alignResetTimezone?: string | null;
  keepWindowsOpen?: boolean;
}

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function assertActiveHours(schedule: ActiveHoursSchedule): void {
  if (!schedule.timezone || !isValidTimezone(schedule.timezone)) {
    throw new HarnessAdminError(400, `activeHours.timezone "${schedule?.timezone}" is not a valid IANA timezone`);
  }
  if (!Array.isArray(schedule.windows) || schedule.windows.length === 0) {
    throw new HarnessAdminError(400, 'activeHours.windows must be a non-empty array');
  }
  for (const window of schedule.windows) {
    if (!Array.isArray(window.days) || window.days.length === 0 || window.days.some((day) => !DAYS.includes(day))) {
      throw new HarnessAdminError(400, `activeHours window days must be a non-empty subset of ${DAYS.join('/')}`);
    }
    if (parseHhMm(window.start) === null || parseHhMm(window.end) === null || window.start === window.end) {
      throw new HarnessAdminError(400, `activeHours window "${window.start}–${window.end}" must use HH:MM and not be empty`);
    }
  }
}

function assertResetSchedule(schedule: HarnessResetSchedule): void {
  if (schedule.kind === 'weekly') {
    if (!DAYS.includes(schedule.day) || parseHhMm(schedule.time) === null || !isValidTimezone(schedule.timezone)) {
      throw new HarnessAdminError(400, 'resetSchedule weekly requires day (mon..sun), time "HH:MM" and a valid IANA timezone');
    }
    return;
  }
  if (schedule.kind === 'cron') {
    // Accepted and stored, but the sweep cannot compute cron occurrences yet — say so instead of
    // letting an operator believe the gate will open itself.
    if (typeof schedule.expr !== 'string' || !schedule.expr.trim() || !isValidTimezone(schedule.timezone)) {
      throw new HarnessAdminError(400, 'resetSchedule cron requires expr and a valid IANA timezone');
    }
    return;
  }
  throw new HarnessAdminError(400, 'resetSchedule.kind must be "weekly" or "cron"');
}

function assertStopPolicy(policy: HarnessStopPolicy): void {
  for (const [key, rule] of Object.entries(policy)) {
    const threshold = rule?.pauseAtUsedPercent;
    if (typeof threshold !== 'number' || threshold < 1 || threshold > 100) {
      throw new HarnessAdminError(400, `stopPolicy["${key}"].pauseAtUsedPercent must be a number between 1 and 100`);
    }
  }
}

/**
 * Operator-facing mutations of the capacity model, shared by the admin routes and the MCP
 * `agentiz.manageWorker`/`agentiz.manage` tools. Everything funnels state changes through
 * AgentCapacityService so gates, cache invalidation and job waking cannot be bypassed.
 */
export class AgentHarnessAdminService {
  /** Replaces the worker's whole binding list, same convention as setWorkspaces. */
  static async setBindings(workerId: string, bindings: HarnessBindingInput[]): Promise<AgentWorkerHarness[]> {
    const worker = await AgentWorker.findByPk(workerId);
    if (!worker) throw new HarnessAdminError(404, `AgentWorker ${workerId} not found`);
    const keys = new Set<string>();
    for (const binding of bindings) {
      const key = binding.harnessKey?.trim();
      if (!key || key.startsWith('/')) throw new HarnessAdminError(400, 'Every binding needs a non-empty harnessKey');
      if (keys.has(key)) throw new HarnessAdminError(400, `Duplicate harnessKey "${key}"`);
      keys.add(key);
      if (binding.subscriptionId && !(await AgentHarnessSubscription.findByPk(binding.subscriptionId))) {
        throw new HarnessAdminError(404, `AgentHarnessSubscription ${binding.subscriptionId} not found`);
      }
    }
    const existing = await AgentWorkerHarness.findAll({ where: { workerId } });
    for (const row of existing) {
      if (!keys.has(row.harnessKey)) await row.destroy();
    }
    for (const binding of bindings) {
      const key = binding.harnessKey.trim();
      const row = existing.find((item) => item.harnessKey === key);
      const values = {
        subscriptionId: binding.subscriptionId ?? null,
        enabled: binding.enabled !== false,
        maxConcurrent: typeof binding.maxConcurrent === 'number' ? Math.max(Math.floor(binding.maxConcurrent), 1) : null,
      };
      if (row) await row.update(values);
      else await AgentWorkerHarness.create({ workerId, harnessKey: key, ...values });
    }
    AgentCapacityService.invalidateGateCache();
    return AgentWorkerHarness.findAll({ where: { workerId }, order: [['harnessKey', 'ASC']] });
  }

  static async setWorkerLimits(workerId: string, limits: WorkerLimitsInput): Promise<AgentWorker> {
    const worker = await AgentWorker.findByPk(workerId);
    if (!worker) throw new HarnessAdminError(404, `AgentWorker ${workerId} not found`);
    const updates: Record<string, unknown> = {};
    if ('maxConcurrentJobs' in limits) {
      if (limits.maxConcurrentJobs !== null && limits.maxConcurrentJobs !== undefined) {
        const value = Math.floor(Number(limits.maxConcurrentJobs));
        if (!Number.isFinite(value) || value < 1 || value > 100) {
          throw new HarnessAdminError(400, 'maxConcurrentJobs must be between 1 and 100 (or null for the worker\'s own report)');
        }
        updates.maxConcurrentJobs = value;
      } else {
        updates.maxConcurrentJobs = null;
      }
    }
    if ('activeHours' in limits) {
      if (limits.activeHours) assertActiveHours(limits.activeHours);
      updates.activeHours = limits.activeHours ?? null;
    }
    if ('timezone' in limits) {
      if (limits.timezone && !isValidTimezone(limits.timezone)) {
        throw new HarnessAdminError(400, `timezone "${limits.timezone}" is not a valid IANA timezone`);
      }
      updates.timezone = limits.timezone ?? null;
    }
    if (Object.keys(updates).length === 0) throw new HarnessAdminError(400, 'Nothing to update: pass maxConcurrentJobs, activeHours or timezone');
    await worker.update(updates);
    return worker;
  }

  /**
   * Manual gate close for `worker × harness`. Resolves (auto-creating, when needed) the binding's
   * subscription first — the limit belongs to the account, so marking one worker exhausted closes
   * every worker of the same subscription, which is the point.
   */
  static async markExhausted(params: {
    workerId?: string;
    subscriptionId?: string;
    harnessKey?: string;
    until: Date;
    reason?: string;
  }): Promise<AgentHarnessSubscription> {
    if (!(params.until instanceof Date) || Number.isNaN(params.until.getTime()) || params.until.getTime() <= Date.now()) {
      throw new HarnessAdminError(400, 'until must be a future date');
    }
    const subscription = await this.resolveSubscription(params);
    return AgentCapacityService.markExhausted(
      subscription.id,
      params.until,
      params.reason?.trim() || 'Отмечено оператором',
      'manual',
    );
  }

  static async clearLimit(params: { workerId?: string; subscriptionId?: string; harnessKey?: string; reason?: string }): Promise<AgentHarnessSubscription> {
    const subscription = await this.resolveSubscription(params);
    return AgentCapacityService.clearLimit(subscription.id, params.reason?.trim() || 'снято оператором', 'manual');
  }

  static async saveSubscription(values: SubscriptionInput, id?: string): Promise<AgentHarnessSubscription> {
    if (values.resetSchedule) assertResetSchedule(values.resetSchedule);
    if (values.stopPolicy) assertStopPolicy(values.stopPolicy);
    if (values.provider && !['anthropic', 'openai', 'other'].includes(values.provider)) {
      throw new HarnessAdminError(400, 'provider must be anthropic, openai or other');
    }
    if (values.authKind && !['subscription', 'api-key'].includes(values.authKind)) {
      throw new HarnessAdminError(400, 'authKind must be subscription or api-key');
    }
    // The alignment trio only configures a best-effort discipline (lib/harnessAlign.ts): a filled
    // value must be valid, but "enabled with a blank hour" is allowed and simply does nothing.
    if (values.alignResetHour !== undefined && values.alignResetHour !== null
      && (!Number.isInteger(values.alignResetHour) || values.alignResetHour < 0 || values.alignResetHour > 23)) {
      throw new HarnessAdminError(400, 'alignResetHour must be an integer between 0 and 23');
    }
    if (values.alignResetTimezone && !isValidTimezone(values.alignResetTimezone)) {
      throw new HarnessAdminError(400, `alignResetTimezone "${values.alignResetTimezone}" is not a valid IANA timezone`);
    }
    if (id) {
      const subscription = await AgentHarnessSubscription.findByPk(id);
      if (!subscription) throw new HarnessAdminError(404, `AgentHarnessSubscription ${id} not found`);
      await subscription.update(Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)));
      AgentCapacityService.invalidateGateCache();
      return subscription;
    }
    const name = values.name?.trim();
    if (!name) throw new HarnessAdminError(400, 'name is required');
    return AgentHarnessSubscription.create({
      name,
      provider: values.provider ?? 'other',
      authKind: values.authKind ?? null,
      notes: values.notes ?? null,
      resetSchedule: values.resetSchedule ?? null,
      stopPolicy: values.stopPolicy ?? null,
      alignResetEnabled: values.alignResetEnabled ?? false,
      alignResetHour: values.alignResetHour ?? null,
      alignResetTimezone: values.alignResetTimezone ?? null,
      keepWindowsOpen: values.keepWindowsOpen ?? false,
    });
  }

  static async deleteSubscription(id: string): Promise<void> {
    const subscription = await AgentHarnessSubscription.findByPk(id);
    if (!subscription) throw new HarnessAdminError(404, `AgentHarnessSubscription ${id} not found`);
    // Bindings survive, unassigned: the next signal auto-creates a fresh implicit subscription.
    await AgentWorkerHarness.update({ subscriptionId: null }, { where: { subscriptionId: id } });
    await subscription.destroy();
    AgentCapacityService.invalidateGateCache();
  }

  private static async resolveSubscription(params: { workerId?: string; subscriptionId?: string; harnessKey?: string }): Promise<AgentHarnessSubscription> {
    if (params.subscriptionId) {
      const subscription = await AgentHarnessSubscription.findByPk(params.subscriptionId);
      if (!subscription) throw new HarnessAdminError(404, `AgentHarnessSubscription ${params.subscriptionId} not found`);
      return subscription;
    }
    if (params.workerId && params.harnessKey) {
      const worker = await AgentWorker.findByPk(params.workerId);
      if (!worker) throw new HarnessAdminError(404, `AgentWorker ${params.workerId} not found`);
      const { subscription } = await AgentCapacityService.ensureBinding(worker, params.harnessKey.trim());
      return subscription;
    }
    throw new HarnessAdminError(400, 'Pass subscriptionId, or workerId together with harnessKey');
  }
}
