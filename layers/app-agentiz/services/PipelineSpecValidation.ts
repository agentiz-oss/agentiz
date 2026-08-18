import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { PipelineSpecDef } from '../types/agentiz';
import { MAX_HOOK_SCRIPT_BYTES } from '../lib/hookEnv';
import { isValidTimezone } from '../lib/activeHours';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, '..', 'schemas', 'pipeline-spec.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateSpec = ajv.compile(schema) as ValidateFunction;

/** The compiled document, for callers that want to show the agent what the shape actually is. */
export const pipelineSpecSchema: Record<string, unknown> = schema;

/**
 * Where a caller who got a rejection can read the shape. Named once here because it is repeated in
 * every rejection message, in the `spec` field tooltip and in the MCP tool descriptions.
 */
export const PIPELINE_SPEC_SCHEMA_TOOL = 'agentiz.pipelineSpecSchema';
const SCHEMA_POINTER = `Call the MCP tool "${PIPELINE_SPEC_SCHEMA_TOOL}" for the full JSON Schema, the cross-field rules and a ready example.`;

/**
 * Rules the JSON Schema cannot state, kept next to the code that enforces them so the catalogue the
 * agent reads and the checks that reject it cannot drift apart.
 */
export const PIPELINE_SPEC_RULES: readonly string[] = [
  'spec is a JSON object, never a JSON string.',
  'stages[].order values are unique and cover 1..N without gaps.',
  'stages[].agentRoleKey must be the `key` of an AgentRole belonging to the same project.',
  'stages[].model overrides that role\'s own model for this stage only; absent means the role\'s model. Free-form string, resolved by the executor (e.g. an Anthropic model id).',
  'source.repositoryId is only accepted with source.kind "worker_workspace" when finalAction.type is "commit", and even then it is optional: the directory pushes through its own configured remote, and pinning a repository only adds a check that the checkout still points at it.',
  'source.workspace names the directory in exactly one of two ways: workspaceKey (looked up in that worker\'s declared Workspaces list — see agentiz.manageWorker {operation:"setWorkspaces"}) or path (an absolute path given directly in the spec, no prior declaration on the worker needed). Setting both, or neither, is rejected. Both forms can push.',
  'Permission to push from a worker directory is never part of the spec: the worker must cover that path with agentiz.manageWorker {operation:"setGitPushRoots"} (or carry git.pushEnabled on the declared workspace, which is also the only way to use a remote other than "origin"). A spec with finalAction "commit" saves either way and fails at queue time if the grant is missing.',
  'source.workspace.createIfMissing only applies alongside path: the worker creates the directory if it does not exist yet, instead of failing. It is rejected alongside workspaceKey — a declared directory is expected to already exist.',
  'source.kind "worker_workspace" allows comment_only, none, or commit through the local workspace Git engine; commit_and_pr remains provider-only.',
  'source.kind "worker_workspace" requires runtime.mode "host" on every stage; a docker container cannot see the worker\'s directory.',
  `hooks.before/after scripts must be non-empty, must not start with a shebang, and must stay under ${MAX_HOOK_SCRIPT_BYTES} bytes.`,
  'constraints.activeHours.timezone must be an IANA zone this server knows (checked with Intl.DateTimeFormat). Window end earlier than start is legal and means an overnight window; start equal to end is rejected as an empty window.',
  'constraints.activeHours only gates when a run may START (enforcement start-only); a run that started inside the window finishes normally outside it. Pausing at the window edge is not accepted yet.',
];

export class PipelineSpecError extends Error {
  constructor(message: string, public readonly errors: string[] = []) {
    super(message);
    this.name = 'PipelineSpecError';
  }
}

/**
 * Builds the rejection the write paths raise. Adminizer's generic CRUD, the MCP `agentiz.manage`
 * tool and the assistant's `create_model_record` skill all surface `error.message` and nothing
 * else, so both the failing fields and the place the shape is documented have to be inside it —
 * otherwise the caller is told "does not match schema" with no way to find out which schema.
 */
function specError(summary: string, errors: string[] = []): PipelineSpecError {
  const sentence = /[.!?]$/.test(summary.trim()) ? summary.trim() : `${summary.trim()}.`;
  const detail = errors.length ? `Problems: ${errors.join('; ')}.` : '';
  return new PipelineSpecError([sentence, detail, SCHEMA_POINTER].filter(Boolean).join(' '), errors);
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors?.length) return [];
  return errors.map((item) => {
    const where = item.instancePath || '/';
    const allowed = (item.params as { allowedValues?: unknown[] } | undefined)?.allowedValues;
    const extra = (item.params as { additionalProperty?: string } | undefined)?.additionalProperty;
    const suffix = allowed ? ` (allowed: ${allowed.join(', ')})` : extra ? ` ("${extra}")` : '';
    return `${where} ${item.message ?? 'validation error'}${suffix}`.trim();
  });
}

/**
 * Accepts what a generic client sends. Adminizer's jsoneditor field and the assistant's
 * `create_model_record` skill both hand JSON columns over as strings, and a string reaching Ajv
 * fails as "must be object", which reads like the document is wrong when only its envelope is.
 */
export function coerceSpec(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw specError(`spec was sent as a string that is not valid JSON (${(error as Error).message}). Send the spec as a JSON object.`);
  }
}

/**
 * Validates a spec document before it is stored and before it is resolved for a run.
 */
export function assertValidSpec(spec: unknown): asserts spec is PipelineSpecDef {
  if (!validateSpec(spec)) {
    throw specError('Pipeline spec does not match schema.', formatErrors(validateSpec.errors));
  }

  const orders = (spec as PipelineSpecDef).stages.map((stage) => stage.order);
  const unique = new Set(orders);
  if (unique.size !== orders.length) {
    throw specError('Pipeline spec stages must have unique `order` values.');
  }
  const sorted = [...orders].sort((a, b) => a - b);
  if (sorted.some((value, index) => value !== index + 1)) {
    throw specError(`Pipeline spec stage orders must be 1..N without gaps, got [${sorted.join(', ')}].`);
  }

  assertSourceIsConsistent(spec as PipelineSpecDef);
  assertHooksAreRunnable(spec as PipelineSpecDef);
  assertConstraintsAreSchedulable(spec as PipelineSpecDef);
}

/**
 * Rules about `constraints.activeHours` the schema cannot state: the timezone has to be one this
 * runtime can actually compute in (checked with the Intl constructor — no new dependency), and an
 * empty window (start == end) would silently never open.
 */
function assertConstraintsAreSchedulable(spec: PipelineSpecDef): void {
  const schedule = spec.constraints?.activeHours;
  if (!schedule) return;
  if (!isValidTimezone(schedule.timezone)) {
    throw specError(`constraints.activeHours.timezone "${schedule.timezone}" is not a valid IANA timezone`);
  }
  for (const [index, window] of (schedule.windows ?? []).entries()) {
    if (window.start === window.end) {
      throw specError(`constraints.activeHours.windows[${index}] has start equal to end ("${window.start}") — an empty window never opens; use an overnight window (end earlier than start) or remove it`);
    }
  }
}

/**
 * Rules about hook scripts that the schema cannot state.
 *
 * Deliberately absent: a check that every `$AGENTIZ_*` name exists. `AGENTIZ_` is our prefix, but a
 * script may define its own (`export AGENTIZ_STEP=2`), so an unknown name is a strong hint rather
 * than a certainty — the editor underlines it, saving is not blocked.
 */
function assertHooksAreRunnable(spec: PipelineSpecDef): void {
  for (const [position, hook] of Object.entries(spec.hooks ?? {})) {
    if (!hook) continue;
    if (!hook.script.trim()) {
      throw specError(`hooks.${position}.script is empty — remove the hook instead of saving a blank one`);
    }
    // The worker writes the shebang itself from `interpreter`. A second one in the body would
    // either be a no-op comment or, worse, read as the real one somewhere down the line.
    if (/^\s*#!/.test(hook.script)) {
      throw specError(`hooks.${position}.script must not start with a shebang: the interpreter is chosen by hooks.${position}.interpreter, and the worker writes the "#!" line itself`);
    }
    const bytes = Buffer.byteLength(hook.script, 'utf8');
    if (bytes > MAX_HOOK_SCRIPT_BYTES) {
      throw specError(`hooks.${position}.script is ${bytes} bytes, over the ${MAX_HOOK_SCRIPT_BYTES} limit — keep long scripts in the repository and call them from here`);
    }
  }
}

/**
 * Cross-field rules the JSON schema deliberately does not express: they read better as messages
 * than as `if/then` branches, and both are about a combination that would only fail at run time.
 */
function assertSourceIsConsistent(spec: PipelineSpecDef): void {
  if (!isWorkspaceSource(spec.source)) return;

  const workspaceGit = spec.finalAction.type === 'commit';
  // `source.repositoryId` is optional here: a worker directory pushes through the remote configured in
  // that checkout, and requiring a hosted repository record would mean maintaining the same URL twice.
  // Pinning one is still allowed and adds the cross-check that the checkout points where the pipeline
  // meant — see the `commit` branch of AgentPipelineService.buildSnapshot.
  if (!workspaceGit && spec.source?.repositoryId) {
    throw specError('source.repositoryId is only allowed with worker_workspace when finalAction.type is "commit"');
  }
  const workspace = spec.source?.workspace;
  if (!workspace?.workerId) {
    throw specError('source.kind "worker_workspace" requires source.workspace.workerId');
  }
  const hasKey = !!workspace.workspaceKey;
  const hasPath = !!workspace.path;
  if (hasKey === hasPath) {
    throw specError('source.workspace must set exactly one of workspaceKey (a directory declared on the worker) or path (an absolute path given directly by the spec)');
  }
  if (hasPath && !workspace.path!.startsWith('/')) {
    throw specError(`source.workspace.path must be absolute, got "${workspace.path}"`);
  }
  if (workspace.createIfMissing && hasKey) {
    throw specError('source.workspace.createIfMissing only applies alongside path, not workspaceKey');
  }
  // Whether that directory may push is the worker operator's grant (AgentWorker.gitPushRoots), not a
  // spec property, so it is deliberately not checked here: this function validates a document, and
  // the grant can be given or withdrawn long after it was saved. AgentPipelineService checks it when
  // the run is actually queued, where the worker record is at hand.
  if (spec.finalAction.type === 'commit_and_pr') {
    throw specError('finalAction "commit_and_pr" is not available for source.kind "worker_workspace"; use "commit", "comment_only" or "none"');
  }
  if (workspaceGit && !spec.finalAction.targetBranch?.mode) {
    throw specError('worker_workspace finalAction.type "commit" requires finalAction.targetBranch.mode "current" or "new"');
  }
  // docker starts a fresh container, so the host directory this pipeline is about would not be in it.
  const dockerStage = spec.stages.find((stage) => stage.runtime?.mode === 'docker');
  if (dockerStage) {
    throw specError(`Stage ${dockerStage.order} (${dockerStage.role}) uses runtime.mode "docker", which cannot see a worker directory; use "host" for source.kind "worker_workspace"`);
  }
}

/** Single place that decides what "this pipeline works in a worker directory" means. */
export function isWorkspaceSource(source: PipelineSpecDef['source']): boolean {
  return source?.kind === 'worker_workspace';
}
