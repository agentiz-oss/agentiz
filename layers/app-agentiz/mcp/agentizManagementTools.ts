import type { IMcpTool } from '@nodeknit/app-mcp';
import { AgentProject } from '../models/AgentProject';
import { AgentRole } from '../models/AgentRole';
import { PipelineSpec } from '../models/PipelineSpec';
import { AgentTask } from '../models/AgentTask';
import { AgentTaskSource } from '../models/AgentTaskSource';
import { AgentTaskComment } from '../models/AgentTaskComment';
import { AgentWorkerRegistryService, WorkerRegistryError } from '../services/AgentWorkerRegistryService';
import { PIPELINE_SPEC_SCHEMA_TOOL } from '../services/PipelineSpecValidation';
import type { AgentWorkerExecutor, AgentWorkerWorkspace } from '../types/agentiz';
import {
  maskProjectForUI,
  maskTaskSourceForUI,
  maskWorkerForUI,
  restoreMaskedSecrets,
  restoreMaskedTaskSourceSecrets,
} from '../lib/secrets';
import { harnessSubscriptionEntity, harnessWorkerOperations } from './agentizCapacityTools';

type Params = Record<string, unknown>;
type ManagedEntity = 'project' | 'role' | 'pipelineSpec' | 'taskSource' | 'task' | 'taskComment';
type ManagedOperation = 'list' | 'get' | 'create' | 'update' | 'delete';

/** Subscriptions go through AgentHarnessAdminService, not generic CRUD: resetSchedule/stopPolicy need validation. */
const HARNESS_SUBSCRIPTION_ENTITY = 'harnessSubscription';

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;

function objectParams(params: unknown): Params {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('JSON object parameters are required');
  }
  return params as Params;
}

function requiredString(params: Params, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name}:string is required`);
  return value.trim();
}

function limitParam(params: Params): number {
  const value = typeof params.limit === 'number' ? params.limit : Number(params.limit ?? LIMIT_DEFAULT);
  return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 1), LIMIT_MAX) : LIMIT_DEFAULT;
}

function valuesParam(params: Params): Params {
  const value = params.values;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('values:object is required');
  }
  return value as Params;
}

function pick(values: Params, fields: readonly string[]): Params {
  return Object.fromEntries(Object.entries(values).filter(([key]) => fields.includes(key)));
}

function serialise(entity: ManagedEntity, record: any): Record<string, unknown> {
  if (entity === 'project') return maskProjectForUI(record);
  if (entity === 'taskSource') return maskTaskSourceForUI(record);
  return record.toJSON();
}

const definitions: Record<ManagedEntity, { model: any; fields: readonly string[]; order: [string, string][] }> = {
  project: {
    model: AgentProject,
    fields: ['name', 'slug', 'description', 'repoProvider', 'repoConfig', 'trackerConfig', 'secrets', 'isActive', 'ownerId'],
    order: [['createdAt', 'DESC']],
  },
  role: {
    model: AgentRole,
    fields: ['projectId', 'key', 'title', 'systemPrompt', 'model', 'allowedTools', 'config'],
    order: [['updatedAt', 'DESC']],
  },
  pipelineSpec: {
    model: PipelineSpec,
    fields: ['projectId', 'name', 'matchTags', 'isDefault', 'isActive', 'spec'],
    order: [['updatedAt', 'DESC']],
  },
  taskSource: {
    model: AgentTaskSource,
    fields: ['projectId', 'name', 'type', 'config', 'secrets', 'isActive', 'syncComments'],
    order: [['updatedAt', 'DESC']],
  },
  task: {
    model: AgentTask,
    fields: ['projectId', 'externalId', 'externalUrl', 'title', 'description', 'tags', 'status', 'priority', 'assigneeId', 'pipelineSpecId'],
    order: [['updatedAt', 'DESC']],
  },
  taskComment: {
    model: AgentTaskComment,
    fields: ['taskId', 'authorKind', 'authorName', 'authorId', 'body', 'origin'],
    order: [['createdAt', 'DESC']],
  },
};

function entityParam(params: Params): ManagedEntity {
  const value = requiredString(params, 'entity');
  if (!(value in definitions)) throw new Error(`Unsupported entity: ${value}`);
  return value as ManagedEntity;
}

function projectWhere(entity: ManagedEntity, projectId: string | undefined): Params {
  if (!projectId || entity === 'project' || entity === 'taskComment') return {};
  return { projectId };
}

/**
 * Controlled CRUD for user-managed Agentiz business records. Run history, queue leases and worker
 * telemetry deliberately remain immutable through this tool: their lifecycle is owned by workers
 * and the existing run/cancel actions. Task comments are retained as an immutable discussion
 * history and cannot be deleted.
 */
export const manageBusinessDataTool: IMcpTool = {
  name: 'agentiz.manage',
  group: 'agentiz-actions',
  groupDescription: 'State-changing Agentiz operations. Inspect the target first and call deliberately.',
  shortDescription: 'Reads and manages Agentiz projects, roles, pipeline specs, task sources, tasks and comments.',
  description: `Controlled CRUD for user-managed Agentiz business records. entity selects the record type; delete requires confirm=true, except taskComment records, which are retained and cannot be deleted. Secrets can be set but are always masked in returned records. Before writing a pipelineSpec, call ${PIPELINE_SPEC_SCHEMA_TOOL} — its "spec" field is a validated JSON document and a wrong shape is rejected.`,
  mode: 'protected',
  inputSchema: {
    type: 'object',
    required: ['entity', 'operation'],
    properties: {
      entity: { type: 'string', enum: [...Object.keys(definitions), HARNESS_SUBSCRIPTION_ENTITY], description: `Writable fields per entity: ${Object.entries(definitions).map(([key, value]) => `${key}(${value.fields.join(', ')})`).join('; ')}; ${HARNESS_SUBSCRIPTION_ENTITY}(name, provider anthropic|openai|other, authKind subscription|api-key, notes, resetSchedule {kind:"weekly",day,time,timezone}, stopPolicy {"<window>":{pauseAtUsedPercent}}).` },
      operation: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete'] },
      id: { type: 'string' }, projectId: { type: 'string' },
      values: { type: 'object', description: `Field values keyed by field name. For entity pipelineSpec, "spec" is a JSON object whose shape comes from ${PIPELINE_SPEC_SCHEMA_TOOL}.` },
      confirm: { type: 'boolean', description: 'Must be true for delete.' },
      limit: { type: 'integer', default: LIMIT_DEFAULT, maximum: LIMIT_MAX },
    },
  },
  async handler(params) {
    const payload = objectParams(params);
    if (payload.entity === HARNESS_SUBSCRIPTION_ENTITY) {
      const operation = requiredString(payload, 'operation') as ManagedOperation;
      if (operation === 'list') return harnessSubscriptionEntity.list();
      if (operation === 'create') return harnessSubscriptionEntity.create(valuesParam(payload) as never);
      const id = requiredString(payload, 'id');
      if (operation === 'get') return harnessSubscriptionEntity.get(id);
      if (operation === 'update') return harnessSubscriptionEntity.update(id, valuesParam(payload) as never);
      if (operation === 'delete') {
        if (payload.confirm !== true) throw new Error('confirm:true is required to delete a subscription');
        return harnessSubscriptionEntity.remove(id);
      }
      throw new Error(`Unsupported operation: ${operation}`);
    }
    const entity = entityParam(payload);
    const operation = requiredString(payload, 'operation') as ManagedOperation;
    if (!['list', 'get', 'create', 'update', 'delete'].includes(operation)) throw new Error(`Unsupported operation: ${operation}`);
    if (operation === 'delete' && entity === 'taskComment') throw new Error('Task comments cannot be deleted');
    const definition = definitions[entity];

    if (operation === 'list') {
      const projectId = typeof payload.projectId === 'string' && payload.projectId.trim() ? payload.projectId.trim() : undefined;
      const records = await definition.model.findAll({ where: projectWhere(entity, projectId), order: definition.order, limit: limitParam(payload) });
      return { count: records.length, items: records.map((record: any) => serialise(entity, record)) };
    }

    if (operation === 'create') {
      const values = pick(valuesParam(payload), definition.fields);
      if (Object.keys(values).length === 0) throw new Error(`values must include at least one writable ${entity} field`);
      if (entity === 'project' && 'secrets' in values) values.secrets = restoreMaskedSecrets(values.secrets, null);
      if (entity === 'taskSource' && 'secrets' in values) values.secrets = restoreMaskedTaskSourceSecrets(values.secrets, null);
      return serialise(entity, await definition.model.create(values));
    }

    const id = requiredString(payload, 'id');
    const record = await definition.model.findByPk(id);
    if (!record) throw new Error(`${entity} ${id} not found`);
    if (operation === 'get') return serialise(entity, record);

    if (operation === 'delete') {
      if (payload.confirm !== true) throw new Error('confirm:true is required to delete a business record');
      await record.destroy();
      return { deleted: true, entity, id };
    }

    const values = pick(valuesParam(payload), definition.fields);
    if (Object.keys(values).length === 0) throw new Error(`values must include at least one writable ${entity} field`);
    if (entity === 'project' && 'secrets' in values) {
      values.secrets = restoreMaskedSecrets(values.secrets, record?.secrets);
    }
    if (entity === 'taskSource' && 'secrets' in values) {
      values.secrets = restoreMaskedTaskSourceSecrets(values.secrets, record?.secrets);
    }

    return serialise(entity, await record.update(values));
  },
};

/** Worker records have token and lease invariants, so their mutations go through the registry service. */
export const manageWorkerTool: IMcpTool = {
  name: 'agentiz.manageWorker',
  group: 'agentiz-actions',
  shortDescription: 'Creates and administers external worker identities safely.',
  description: 'Creates, pauses, resumes, revokes, deletes, rotates the token of, or changes allowed projects, declared workspaces, Git push roots and manual executor profiles for an external worker. A pipeline can name any absolute directory on a worker itself, but pushing from one requires setGitPushRoots here — that grant is never part of a pipeline spec. Newly issued tokens are returned once only. Harness capacity: setHarnessBindings (worker×harness→subscription), setLimits (maxConcurrentJobs/activeHours/timezone), markHarnessExhausted (close the subscription gate until a date — deferred jobs reschedule automatically) and clearHarnessLimit (reopen early; wakes waiting jobs). Subscriptions themselves are managed via agentiz.manage entity "harnessSubscription".',
  mode: 'protected',
  inputSchema: {
    type: 'object', required: ['operation'],
    properties: {
      operation: { type: 'string', enum: ['create', 'pause', 'resume', 'revoke', 'delete', 'rotateToken', 'setAllowedProjects', 'setWorkspaces', 'setGitPushRoots', 'setManualExecutors', 'setHarnessBindings', 'setLimits', 'markHarnessExhausted', 'clearHarnessLimit'] },
      workerId: { type: 'string' }, name: { type: 'string' }, allowedProjectIds: { type: ['array', 'null'], items: { type: 'string' } },
      harnessBindings: {
        type: 'array',
        description: 'setHarnessBindings only. REPLACES the worker\'s whole binding list: [{harnessKey: "claude", subscriptionId?, enabled?, maxConcurrent?}]. A binding with no subscriptionId gets an implicit one on the first limit signal.',
        items: {
          type: 'object', required: ['harnessKey'],
          properties: {
            harnessKey: { type: 'string' }, subscriptionId: { type: ['string', 'null'] },
            enabled: { type: 'boolean', default: true }, maxConcurrent: { type: ['integer', 'null'] },
          },
        },
      },
      limits: {
        type: 'object',
        description: 'setLimits only: { maxConcurrentJobs?: 1..100|null, activeHours?: {timezone, windows:[{days,start,end}]}|null, timezone?: IANA|null }.',
        properties: {
          maxConcurrentJobs: { type: ['integer', 'null'] },
          activeHours: { type: ['object', 'null'] },
          timezone: { type: ['string', 'null'] },
        },
      },
      subscriptionId: { type: 'string', description: 'markHarnessExhausted/clearHarnessLimit: address the subscription directly instead of workerId+harnessKey.' },
      harnessKey: { type: 'string', description: 'markHarnessExhausted/clearHarnessLimit together with workerId: resolves (auto-creating) that binding\'s subscription.' },
      until: { type: 'string', description: 'markHarnessExhausted: ISO date until which the subscription is closed ("токены придут в 18:00" одной командой — очередь перепланируется).' },
      gitPushRoots: {
        type: ['array', 'null'],
        description: 'setGitPushRoots only. Absolute path prefixes this machine\'s operator allows Git push from, e.g. ["/srv/projects"]; every directory below one of them may commit and push. This REPLACES the whole list; null or [] withdraws the grant. "/" is refused. Needed for finalAction "commit" on a worker_workspace pipeline, whether the spec names the directory by path or by a declared key.',
        items: { type: 'string' },
      },
      workspaces: {
        type: ['array', 'null'],
        description: 'setWorkspaces only. Named directories a pipeline can reference through source.workspace.workspaceKey instead of hardcoding a path — useful when the path should stay correctable without editing every spec. This REPLACES the whole list: read the worker\'s current workspaces with agentiz.workerDetails and send them back alongside the new one, or they are dropped. Paths must be absolute.',
        items: {
          type: 'object', required: ['key', 'path'],
          properties: {
            key: { type: 'string', description: 'Stable identifier a pipeline spec stores. Unique within the worker, and must not start with "/".' },
            path: { type: 'string', description: 'Absolute path on the worker machine, e.g. /prj/lyapka-rf.' },
            label: { type: 'string' }, description: { type: 'string' },
            projectId: {
              type: ['string', 'null'],
              description: 'The project this directory belongs to. Set it and only that project\'s pipeline specs may run here — a spec of another project is refused when saved and when a run is queued. Omit/null keeps the directory shared, as before this field existed. Bind it whenever the directory is a project checkout: a workspace proposal reserves the directory, and an unbound one blocks the other project\'s runs.',
            },
            git: {
              type: 'object', required: ['pushEnabled'],
              description: 'Per-directory push grant, equivalent to a covering gitPushRoots prefix and the only way to push to a remote other than "origin".',
              properties: {
                pushEnabled: { type: 'boolean', description: 'Must be true when git is present; omit the whole block to grant nothing here.' },
                remote: { type: 'string', description: 'Remote already configured in that checkout. Defaults to origin.' },
              },
            },
          },
        },
      },
      manualExecutors: {
        type: ['array', 'null'],
        description: 'setManualExecutors only. Named ACP profiles offered when manually starting a run. This REPLACES the whole list. Commands are configured here on the worker profile, never supplied by the run request.',
        items: {
          type: 'object', required: ['key', 'acpCommand'],
          properties: {
            key: { type: 'string', description: 'Unique stable key, for example "claude" or "codex".' },
            title: { type: 'string' },
            acpCommand: { type: 'array', minItems: 1, items: { type: 'string' } },
          },
        },
      },
      reason: { type: 'string' }, confirm: { type: 'boolean', description: 'Must be true for delete or revoke.' },
    },
  },
  async handler(params) {
    const payload = objectParams(params);
    const operation = requiredString(payload, 'operation');
    const allowedProjectIds = Array.isArray(payload.allowedProjectIds) ? payload.allowedProjectIds.map(String) : null;
    try {
      if (operation === 'create') {
        const created = await AgentWorkerRegistryService.create({ name: requiredString(payload, 'name'), allowedProjectIds, createdBy: 'mcp' });
        return { worker: maskWorkerForUI(created.worker), token: created.token };
      }
      if (operation === 'setHarnessBindings') return harnessWorkerOperations.setHarnessBindings(payload);
      if (operation === 'setLimits') return harnessWorkerOperations.setLimits(payload);
      if (operation === 'markHarnessExhausted') return harnessWorkerOperations.markHarnessExhausted(payload);
      if (operation === 'clearHarnessLimit') return harnessWorkerOperations.clearHarnessLimit(payload);
      const workerId = requiredString(payload, 'workerId');
      if (operation === 'pause') return maskWorkerForUI(await AgentWorkerRegistryService.pause(workerId, typeof payload.reason === 'string' ? payload.reason : null));
      if (operation === 'resume') return maskWorkerForUI(await AgentWorkerRegistryService.resume(workerId));
      if (operation === 'setAllowedProjects') return maskWorkerForUI(await AgentWorkerRegistryService.setAllowedProjects(workerId, allowedProjectIds));
      if (operation === 'setWorkspaces') {
        // Null and [] both mean "declare nothing"; anything else has to be the full replacement list.
        if (payload.workspaces !== null && !Array.isArray(payload.workspaces)) {
          throw new Error('workspaces:array is required for setWorkspaces — it replaces the whole list, so include the entries you want to keep');
        }
        return maskWorkerForUI(await AgentWorkerRegistryService.setWorkspaces(workerId, payload.workspaces as AgentWorkerWorkspace[] | null));
      }
      if (operation === 'setGitPushRoots') {
        if (payload.gitPushRoots !== null && !Array.isArray(payload.gitPushRoots)) {
          throw new Error('gitPushRoots:array is required for setGitPushRoots — it replaces the whole list; pass [] or null to withdraw the push grant');
        }
        const roots = Array.isArray(payload.gitPushRoots) ? payload.gitPushRoots.map(String) : null;
        return maskWorkerForUI(await AgentWorkerRegistryService.setGitPushRoots(workerId, roots));
      }
      if (operation === 'setManualExecutors') {
        if (payload.manualExecutors !== null && !Array.isArray(payload.manualExecutors)) {
          throw new Error('manualExecutors:array is required for setManualExecutors — it replaces the whole list; pass [] or null to clear it');
        }
        return maskWorkerForUI(await AgentWorkerRegistryService.setManualExecutors(workerId, payload.manualExecutors as AgentWorkerExecutor[] | null));
      }
      if (operation === 'rotateToken') {
        const rotated = await AgentWorkerRegistryService.rotateToken(workerId);
        return { worker: maskWorkerForUI(rotated.worker), token: rotated.token };
      }
      if (operation === 'revoke' || operation === 'delete') {
        if (payload.confirm !== true) throw new Error('confirm:true is required to revoke or delete a worker');
        if (operation === 'revoke') return maskWorkerForUI(await AgentWorkerRegistryService.revoke(workerId, typeof payload.reason === 'string' ? payload.reason : null));
        await AgentWorkerRegistryService.remove(workerId);
        return { deleted: true, workerId };
      }
      throw new Error(`Unsupported worker operation: ${operation}`);
    } catch (error) {
      if (error instanceof WorkerRegistryError) throw new Error(error.message);
      throw error;
    }
  },
};
