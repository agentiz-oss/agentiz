import type { IMcpTool } from '@nodeknit/app-mcp';
import { AgentCapacityService } from '../services/AgentCapacityService';
import { AgentHarnessAdminService, HarnessAdminError } from '../services/AgentHarnessAdminService';
import type { SubscriptionInput } from '../services/AgentHarnessAdminService';
import { subscriptionView } from '../lib/capacityViews';

type Params = Record<string, unknown>;

function objectParams(params: unknown): Params {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('JSON object parameters are required');
  }
  return params as Params;
}

function stringParam(params: Params, name: string): string | undefined {
  const value = params[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function rethrow(error: unknown): never {
  if (error instanceof HarnessAdminError) throw new Error(error.message);
  throw error;
}

/**
 * The transport for usage telemetry from outside the server: a cron script on a worker machine
 * (where the Claude OAuth token actually lives), an external monitor, or a person after a look at
 * /usage. Two body shapes on purpose: `raw` needs a provider's interpretReport, while an already
 * normalized `{windows, meta?, accountId?}` is stored as-is — so history collection works from
 * day one, before any provider layer exists.
 */
const reportHarnessUsageTool: IMcpTool = {
  name: 'agentiz.reportHarnessUsage',
  group: 'agentiz-actions',
  shortDescription: 'Pushes a usage snapshot for worker × harness into the capacity subsystem.',
  description: 'Records harness usage telemetry. Provide workerId (or subscriptionId) and harnessKey, plus either `raw` (interpreted by the registered harness limit provider) or a normalized `snapshot` {windows:[{key,label?,usedPercent?,resetsAt?}], meta?, accountId?} stored as-is. Every accepted report becomes an AgentHarnessUsageSample row and updates the subscription\'s cached windows; stopPolicy thresholds may close the claim gate preventively.',
  mode: 'protected',
  inputSchema: {
    type: 'object',
    required: ['harnessKey'],
    properties: {
      workerId: { type: 'string' },
      subscriptionId: { type: 'string' },
      harnessKey: { type: 'string', description: 'Normalized key: claude, codex, …' },
      raw: { description: 'Provider-specific payload; needs a registered provider with interpretReport.' },
      snapshot: {
        type: 'object',
        description: 'Already normalized snapshot: { windows: [{key, label?, usedPercent?, resetsAt?}], meta?, accountId? }.',
        properties: {
          windows: { type: 'array', items: { type: 'object', required: ['key'], properties: {
            key: { type: 'string' }, label: { type: 'string' },
            usedPercent: { type: 'number' }, resetsAt: { type: 'string' },
          } } },
          meta: {},
          accountId: { type: 'string' },
        },
      },
      observedAt: { type: 'string', description: 'ISO time of the measurement; defaults to now.' },
    },
  },
  async handler(params) {
    const payload = objectParams(params);
    const harnessKey = stringParam(payload, 'harnessKey');
    if (!harnessKey) throw new Error('harnessKey:string is required');
    const workerId = stringParam(payload, 'workerId');
    const subscriptionId = stringParam(payload, 'subscriptionId');
    if (!workerId && !subscriptionId) throw new Error('workerId or subscriptionId is required');

    const observedAtText = stringParam(payload, 'observedAt');
    const result = await AgentCapacityService.applyReport({
      workerId,
      subscriptionId,
      harnessKey,
      raw: payload.raw,
      snapshot: payload.snapshot as { windows?: unknown[]; meta?: unknown; accountId?: string } | undefined,
      observedAt: observedAtText ? new Date(observedAtText) : undefined,
    });
    return {
      sampleId: result.sample.id,
      subscription: result.subscription ? subscriptionView(result.subscription) : null,
      warnings: result.warnings,
    };
  },
};

export const agentizCapacityActionTools: IMcpTool[] = [reportHarnessUsageTool];

/**
 * Shared handler bodies for the harness operations added to `agentiz.manageWorker` — kept here so
 * the MCP tool file stays a catalogue.
 */
export const harnessWorkerOperations = {
  async setHarnessBindings(payload: Params) {
    try {
      const workerId = stringParam(payload, 'workerId');
      if (!workerId) throw new Error('workerId:string is required');
      if (!Array.isArray(payload.harnessBindings)) {
        throw new Error('harnessBindings:array is required — it replaces the whole list: [{harnessKey, subscriptionId?, enabled?, maxConcurrent?}]');
      }
      const bindings = await AgentHarnessAdminService.setBindings(workerId, payload.harnessBindings as never);
      return { workerId, bindings: bindings.map((binding) => binding.toJSON()) };
    } catch (error) {
      rethrow(error);
    }
  },
  async setLimits(payload: Params) {
    try {
      const workerId = stringParam(payload, 'workerId');
      if (!workerId) throw new Error('workerId:string is required');
      const limits = payload.limits;
      if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
        throw new Error('limits:object is required: { maxConcurrentJobs?, activeHours?, timezone? }');
      }
      const worker = await AgentHarnessAdminService.setWorkerLimits(workerId, limits as never);
      return {
        workerId: worker.id,
        maxConcurrentJobs: worker.effectiveMaxConcurrentJobs(),
        activeHours: worker.activeHours,
        timezone: worker.timezone,
      };
    } catch (error) {
      rethrow(error);
    }
  },
  async markHarnessExhausted(payload: Params) {
    try {
      const untilText = stringParam(payload, 'until');
      if (!untilText) throw new Error('until:string (ISO date) is required');
      const subscription = await AgentHarnessAdminService.markExhausted({
        workerId: stringParam(payload, 'workerId'),
        subscriptionId: stringParam(payload, 'subscriptionId'),
        harnessKey: stringParam(payload, 'harnessKey'),
        until: new Date(untilText),
        reason: stringParam(payload, 'reason'),
      });
      return subscriptionView(subscription);
    } catch (error) {
      rethrow(error);
    }
  },
  async clearHarnessLimit(payload: Params) {
    try {
      const subscription = await AgentHarnessAdminService.clearLimit({
        workerId: stringParam(payload, 'workerId'),
        subscriptionId: stringParam(payload, 'subscriptionId'),
        harnessKey: stringParam(payload, 'harnessKey'),
        reason: stringParam(payload, 'reason'),
      });
      return subscriptionView(subscription);
    } catch (error) {
      rethrow(error);
    }
  },
};

/** CRUD bodies for `agentiz.manage` entity `harnessSubscription`. */
export const harnessSubscriptionEntity = {
  async list() {
    const { AgentHarnessSubscription } = await import('../models/AgentHarnessSubscription');
    const items = await AgentHarnessSubscription.findAll({ order: [['name', 'ASC']] });
    return { count: items.length, items: items.map(subscriptionView) };
  },
  async get(id: string) {
    const { AgentHarnessSubscription } = await import('../models/AgentHarnessSubscription');
    const subscription = await AgentHarnessSubscription.findByPk(id);
    if (!subscription) throw new Error(`harnessSubscription ${id} not found`);
    return subscriptionView(subscription);
  },
  async create(values: SubscriptionInput) {
    try {
      return subscriptionView(await AgentHarnessAdminService.saveSubscription(values));
    } catch (error) {
      rethrow(error);
    }
  },
  async update(id: string, values: SubscriptionInput) {
    try {
      return subscriptionView(await AgentHarnessAdminService.saveSubscription(values, id));
    } catch (error) {
      rethrow(error);
    }
  },
  async remove(id: string) {
    try {
      await AgentHarnessAdminService.deleteSubscription(id);
      return { deleted: true, id };
    } catch (error) {
      rethrow(error);
    }
  },
};
