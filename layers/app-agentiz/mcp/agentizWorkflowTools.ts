import type { IMcpTool } from '@nodeknit/app-mcp';
import type { WorkflowSpec } from '@nodeknit/app-workflow';
import { workflowAdminApi, workflowEngine } from '../lib/workflow/engineBridge';

/**
 * Workflow tools: the same `WorkflowAdminApi` the canvas talks to, exposed to agents.
 *
 * Two rules from the design (`.ai-notes/workflow-lowcode-plan-v2.md`) shape this file. There is no
 * "run the workflow" verb — a flow runs because one of its triggers fired, and the only manual
 * gesture is firing *one named trigger node*, which is a debugging entry, not an operating one.
 * And validation errors have to travel in the message: an agent writing a spec sees nothing else.
 */

type Params = Record<string, unknown>;

const DEFAULT_PROVIDER = 'agentiz';
const RUN_LIMIT_DEFAULT = 10;

function objectParams(params: unknown): Params {
  return params !== null && typeof params === 'object' && !Array.isArray(params) ? params as Params : {};
}

function stringParam(params: Params, name: string): string | undefined {
  const value = params[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requireString(params: Params, name: string): string {
  const value = stringParam(params, name);
  if (!value) throw new Error(`${name}:string is required`);
  return value;
}

function providerOf(params: Params): string {
  return stringParam(params, 'providerId') ?? DEFAULT_PROVIDER;
}

/** Ajv-less: the spec's own shape is checked by the engine, this only refuses obvious garbage. */
function specParam(params: Params): WorkflowSpec {
  const spec = params.spec;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('spec:object is required (the whole graph: {id, name, active, nodes[], edges[]})');
  }
  const candidate = spec as Partial<WorkflowSpec>;
  if (!candidate.id) throw new Error('spec.id is required — save replaces one existing workflow');
  if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) {
    throw new Error('spec.nodes[] and spec.edges[] are required');
  }
  return candidate as WorkflowSpec;
}

/** The engine throws a plain Error with `problems` attached; MCP shows only the message. */
function describeSaveError(error: unknown): never {
  const problems = (error as { problems?: Array<{ nodeId?: string; message: string }> }).problems;
  if (problems?.length) {
    const detail = problems.map((p) => (p.nodeId ? `[${p.nodeId}] ${p.message}` : p.message)).join('; ');
    throw new Error(`Workflow spec is invalid: ${detail}`);
  }
  throw error;
}

const workflowsTool: IMcpTool = {
  name: 'agentiz.workflows', group: 'agentiz',
  shortDescription: 'Lists workflows (low-code graphs) with their active state.',
  description: 'Read-only list of workflow graphs: id, name, whether its triggers are armed (active), the owning project when there is one, and whether this provider allows editing.',
  mode: 'public',
  inputSchema: { type: 'object', properties: {} },
  async handler() {
    const items = await workflowAdminApi().listSpecs();
    return { count: items.length, items };
  },
};

const workflowDetailsTool: IMcpTool = {
  name: 'agentiz.workflowDetails', group: 'agentiz',
  shortDescription: 'One workflow: its graph, lint problems and recent runs.',
  description: 'Read-only. Returns the whole graph, the validation problems it currently has (the same ones that would refuse a save) and its most recent runs with their node-by-node trace. Pass runId to get one run instead.',
  mode: 'public',
  inputSchema: {
    type: 'object',
    properties: {
      specId: { type: 'string' },
      providerId: { type: 'string', description: `defaults to "${DEFAULT_PROVIDER}"` },
      runId: { type: 'string', description: 'return this single run instead of the workflow' },
      runLimit: { type: 'number' },
    },
  },
  async handler(params) {
    const payload = objectParams(params);
    const api = workflowAdminApi();

    const runId = stringParam(payload, 'runId');
    if (runId) {
      const run = await api.getRun(runId);
      if (!run) throw new Error(`Workflow run ${runId} not found`);
      return { run };
    }

    const specId = requireString(payload, 'specId');
    const runLimit = typeof payload.runLimit === 'number' ? Math.max(1, Math.min(50, Math.floor(payload.runLimit))) : RUN_LIMIT_DEFAULT;
    const details = await api.getSpec(providerOf(payload), specId, runLimit);
    if (!details) throw new Error(`Workflow ${specId} not found`);
    return details;
  },
};

const workflowSchemaTool: IMcpTool = {
  name: 'agentiz.workflowSchema', group: 'agentiz',
  shortDescription: 'Self-description for writing workflow graphs: node palette, config schemas, events.',
  description: 'Read-only. Everything needed to write a valid graph for agentiz.manageWorkflow: the spec shape, every registered node type with its ports and config JSON schema, and the event catalogue a trigger node can name. The counterpart of agentiz.pipelineSpecSchema for workflows.',
  mode: 'public',
  inputSchema: { type: 'object', properties: {} },
  async handler() {
    const describe = await workflowAdminApi().describe();
    return {
      spec: {
        shape: {
          id: 'string (assigned on create)',
          name: 'string',
          active: 'boolean — false keeps the triggers disarmed',
          version: 'number — bumped on every save, do not set by hand',
          nodes: '[{ id, type, name?, config?, ui?: {x, y} }]',
          edges: '[{ from, fromPort?, to }]',
        },
        rules: [
          'Ports are named: `fromPort` must be one of the source type\'s outputs; omitted means its first one.',
          'A trigger node takes no incoming edges, every other node takes at most one (no fan-in).',
          'The graph must be acyclic.',
          'ui.x/ui.y are optional — the canvas lays a graph out on its own.',
          'Saving is deploying: the triggers of an active workflow are rearmed immediately, running instances keep their version.',
        ],
      },
      nodeTypes: describe.nodeTypes,
      events: describe.events,
    };
  },
};

const manageWorkflowTool: IMcpTool = {
  name: 'agentiz.manageWorkflow', group: 'agentiz-actions',
  groupDescription: 'State-changing Agentiz operations. Inspect the target first and call deliberately.',
  shortDescription: 'Creates, saves, activates, deactivates or deletes a workflow.',
  description: 'Writes a workflow graph. `create` makes an empty inactive one, `save` replaces the whole graph (call agentiz.workflowSchema first; validation errors come back naming the offending nodes), `activate`/`deactivate` arm and disarm its triggers, `delete` removes it. Activating a workflow means it starts reacting to real events — it can create pipeline runs on its own.',
  mode: 'protected',
  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['create', 'save', 'activate', 'deactivate', 'delete'] },
      providerId: { type: 'string', description: `defaults to "${DEFAULT_PROVIDER}"` },
      specId: { type: 'string' },
      name: { type: 'string', description: 'for create' },
      spec: { type: 'object', description: 'for save: the whole graph' },
    },
  },
  async handler(params) {
    const payload = objectParams(params);
    const api = workflowAdminApi();
    const providerId = providerOf(payload);
    const action = requireString(payload, 'action');

    if (action === 'create') {
      return { spec: await api.createSpec(providerId, { name: stringParam(payload, 'name') ?? 'Новый воркфлоу' }) };
    }

    if (action === 'save') {
      const spec = specParam(payload);
      try {
        const saved = await api.saveSpec(providerId, spec);
        return { spec: saved, problems: api.validate(saved) };
      } catch (error) {
        return describeSaveError(error);
      }
    }

    if (action === 'activate' || action === 'deactivate') {
      const specId = requireString(payload, 'specId');
      const current = await api.getSpec(providerId, specId, 0);
      if (!current) throw new Error(`Workflow ${specId} not found`);
      try {
        // Through saveSpec on purpose: activating validates the graph and rebinds the triggers,
        // so an unfinished workflow cannot be armed by flipping a flag.
        const saved = await api.saveSpec(providerId, { ...current.spec, active: action === 'activate' });
        return { spec: saved };
      } catch (error) {
        return describeSaveError(error);
      }
    }

    if (action === 'delete') {
      await api.deleteSpec(providerId, requireString(payload, 'specId'));
      return { ok: true };
    }

    throw new Error(`Unknown action "${action}"`);
  },
};

const fireWorkflowTriggerTool: IMcpTool = {
  name: 'agentiz.fireWorkflowTrigger', group: 'agentiz-actions',
  shortDescription: 'Fires one trigger node by hand (the canvas\'s ▶ button).',
  description: 'Debugging entry point: runs the branch hanging off one named trigger node, optionally with a msg to inject. There is deliberately no "run the whole workflow" verb — in production a workflow only runs because a real trigger fired. The branch does whatever it does, including starting pipeline runs.',
  mode: 'protected',
  inputSchema: {
    type: 'object',
    required: ['specId', 'nodeId'],
    properties: {
      specId: { type: 'string' },
      nodeId: { type: 'string', description: 'id of the trigger node to fire' },
      providerId: { type: 'string', description: `defaults to "${DEFAULT_PROVIDER}"` },
      msg: { type: 'object', description: 'starting msg, e.g. {"payload":{"taskId":"..."}}' },
    },
  },
  async handler(params) {
    const payload = objectParams(params);
    const providerId = providerOf(payload);
    const specId = requireString(payload, 'specId');
    const nodeId = requireString(payload, 'nodeId');

    const engine = workflowEngine();
    if (!engine) throw new Error('Workflow engine is not running (is app-workflow enabled?)');
    const spec = await engine.getSpec(providerId, specId);
    if (!spec) throw new Error(`Workflow ${specId} not found`);
    const node = spec.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error(`Workflow ${specId} has no node "${nodeId}"`);
    // Refused rather than started from "the entry node": a flow with two triggers would otherwise
    // silently run the wrong branch, and the run's own trigger field would name a node that is not
    // a trigger.
    if (engine.registry.get(node.type)?.kind !== 'trigger') {
      throw new Error(`Node "${nodeId}" is a ${node.type}, not a trigger node`);
    }

    const msg = payload.msg && typeof payload.msg === 'object' && !Array.isArray(payload.msg)
      ? payload.msg as Record<string, unknown>
      : undefined;
    return { run: await workflowAdminApi().startRun(providerId, specId, msg, nodeId) };
  },
};

const cancelWorkflowRunTool: IMcpTool = {
  name: 'agentiz.cancelWorkflowRun', group: 'agentiz-actions',
  shortDescription: 'Cancels an unfinished workflow run.',
  description: 'Stops one workflow run — a graph that is walking, waiting for an external result or deferred. Pipeline runs it already started are not cancelled by this (use agentiz.cancelRun for those).',
  mode: 'protected',
  inputSchema: { type: 'object', required: ['runId'], properties: { runId: { type: 'string' } } },
  async handler(params) {
    const payload = objectParams(params);
    const runId = requireString(payload, 'runId');
    const api = workflowAdminApi();
    await api.cancelRun(runId);
    return { run: await api.getRun(runId) };
  },
};

export const agentizWorkflowMcpTools: IMcpTool[] = [
  workflowsTool,
  workflowDetailsTool,
  workflowSchemaTool,
  manageWorkflowTool,
  fireWorkflowTriggerTool,
  cancelWorkflowRunTool,
];
