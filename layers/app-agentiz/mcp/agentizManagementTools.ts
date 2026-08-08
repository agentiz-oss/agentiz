import type { IMcpTool } from '@nodeknit/app-mcp';
import { AgentProject } from '../models/AgentProject';
import { AgentRole } from '../models/AgentRole';
import { PipelineSpec } from '../models/PipelineSpec';
import { AgentTask } from '../models/AgentTask';
import { AgentTaskSource } from '../models/AgentTaskSource';
import { AgentTaskComment } from '../models/AgentTaskComment';
import { AgentWorkerRegistryService, WorkerRegistryError } from '../services/AgentWorkerRegistryService';
import { PIPELINE_SPEC_SCHEMA_TOOL } from '../services/PipelineSpecValidation';
import {
  maskProjectForUI,
  maskTaskSourceForUI,
  maskWorkerForUI,
  restoreMaskedSecrets,
  restoreMaskedTaskSourceSecrets,
} from '../lib/secrets';

type Params = Record<string, unknown>;
type ManagedEntity = 'project' | 'role' | 'pipelineSpec' | 'taskSource' | 'task' | 'taskComment';
type ManagedOperation = 'list' | 'get' | 'create' | 'update' | 'delete';

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
 * and the existing run/cancel actions.
 */
export const manageBusinessDataTool: IMcpTool = {
  name: 'agentiz.manage',
  group: 'agentiz-actions',
  groupDescription: 'State-changing Agentiz operations. Inspect the target first and call deliberately.',
  shortDescription: 'Reads and manages Agentiz projects, roles, pipeline specs, task sources, tasks and comments.',
  description: `Controlled CRUD for user-managed Agentiz business records. entity selects the record type; delete requires confirm=true. Secrets can be set but are always masked in returned records. Before writing a pipelineSpec, call ${PIPELINE_SPEC_SCHEMA_TOOL} — its "spec" field is a validated JSON document and a wrong shape is rejected.`,
  mode: 'protected',
  inputSchema: {
    type: 'object',
    required: ['entity', 'operation'],
    properties: {
      entity: { type: 'string', enum: Object.keys(definitions), description: `Writable fields per entity: ${Object.entries(definitions).map(([key, value]) => `${key}(${value.fields.join(', ')})`).join('; ')}.` },
      operation: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete'] },
      id: { type: 'string' }, projectId: { type: 'string' },
      values: { type: 'object', description: `Field values keyed by field name. For entity pipelineSpec, "spec" is a JSON object whose shape comes from ${PIPELINE_SPEC_SCHEMA_TOOL}.` },
      confirm: { type: 'boolean', description: 'Must be true for delete.' },
      limit: { type: 'integer', default: LIMIT_DEFAULT, maximum: LIMIT_MAX },
    },
  },
  async handler(params) {
    const payload = objectParams(params);
    const entity = entityParam(payload);
    const operation = requiredString(payload, 'operation') as ManagedOperation;
    if (!['list', 'get', 'create', 'update', 'delete'].includes(operation)) throw new Error(`Unsupported operation: ${operation}`);
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
  description: 'Creates, pauses, resumes, revokes, deletes, rotates the token of, or changes allowed projects for an external worker. Newly issued tokens are returned once only.',
  mode: 'protected',
  inputSchema: {
    type: 'object', required: ['operation'],
    properties: {
      operation: { type: 'string', enum: ['create', 'pause', 'resume', 'revoke', 'delete', 'rotateToken', 'setAllowedProjects'] },
      workerId: { type: 'string' }, name: { type: 'string' }, allowedProjectIds: { type: ['array', 'null'], items: { type: 'string' } },
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
      const workerId = requiredString(payload, 'workerId');
      if (operation === 'pause') return maskWorkerForUI(await AgentWorkerRegistryService.pause(workerId, typeof payload.reason === 'string' ? payload.reason : null));
      if (operation === 'resume') return maskWorkerForUI(await AgentWorkerRegistryService.resume(workerId));
      if (operation === 'setAllowedProjects') return maskWorkerForUI(await AgentWorkerRegistryService.setAllowedProjects(workerId, allowedProjectIds));
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
