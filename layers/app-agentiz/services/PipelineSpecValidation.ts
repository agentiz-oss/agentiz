import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { PipelineSpecDef } from '../types/agentiz';
import { MAX_HOOK_SCRIPT_BYTES } from '../lib/hookEnv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, '..', 'schemas', 'pipeline-spec.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateSpec = ajv.compile(schema) as ValidateFunction;

export class PipelineSpecError extends Error {
  constructor(message: string, public readonly errors: string[] = []) {
    super(message);
    this.name = 'PipelineSpecError';
  }
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors?.length) return [];
  return errors.map((item) => `${item.instancePath || '/'} ${item.message ?? 'validation error'}`.trim());
}

/**
 * Validates a spec document before it is stored and before it is resolved for a run.
 */
export function assertValidSpec(spec: unknown): asserts spec is PipelineSpecDef {
  if (!validateSpec(spec)) {
    throw new PipelineSpecError('Pipeline spec does not match schema', formatErrors(validateSpec.errors));
  }

  const orders = (spec as PipelineSpecDef).stages.map((stage) => stage.order);
  const unique = new Set(orders);
  if (unique.size !== orders.length) {
    throw new PipelineSpecError('Pipeline spec stages must have unique `order` values');
  }
  const sorted = [...orders].sort((a, b) => a - b);
  if (sorted.some((value, index) => value !== index + 1)) {
    throw new PipelineSpecError(`Pipeline spec stage orders must be 1..N without gaps, got [${sorted.join(', ')}]`);
  }

  assertSourceIsConsistent(spec as PipelineSpecDef);
  assertHooksAreRunnable(spec as PipelineSpecDef);
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
      throw new PipelineSpecError(`hooks.${position}.script is empty — remove the hook instead of saving a blank one`);
    }
    // The worker writes the shebang itself from `interpreter`. A second one in the body would
    // either be a no-op comment or, worse, read as the real one somewhere down the line.
    if (/^\s*#!/.test(hook.script)) {
      throw new PipelineSpecError(`hooks.${position}.script must not start with a shebang: the interpreter is chosen by hooks.${position}.interpreter, and the worker writes the "#!" line itself`);
    }
    const bytes = Buffer.byteLength(hook.script, 'utf8');
    if (bytes > MAX_HOOK_SCRIPT_BYTES) {
      throw new PipelineSpecError(`hooks.${position}.script is ${bytes} bytes, over the ${MAX_HOOK_SCRIPT_BYTES} limit — keep long scripts in the repository and call them from here`);
    }
  }
}

/**
 * Cross-field rules the JSON schema deliberately does not express: they read better as messages
 * than as `if/then` branches, and both are about a combination that would only fail at run time.
 */
function assertSourceIsConsistent(spec: PipelineSpecDef): void {
  if (!isWorkspaceSource(spec.source)) return;

  // Both name where the code comes from, and they cannot both be right.
  if (spec.source?.repositoryId) {
    throw new PipelineSpecError('source.repositoryId is meaningless with source.kind "worker_workspace": the run works in a directory, not in a repository');
  }
  if (!spec.source?.workspace?.workerId || !spec.source.workspace.workspaceKey) {
    throw new PipelineSpecError('source.kind "worker_workspace" requires source.workspace.workerId and source.workspace.workspaceKey');
  }
  // Nothing to push to: the directory belongs to the worker's machine, not to a git host.
  if (spec.finalAction.type === 'commit_and_pr' || spec.finalAction.type === 'commit') {
    throw new PipelineSpecError(`finalAction "${spec.finalAction.type}" is not available for source.kind "worker_workspace"; use "comment_only" or "none"`);
  }
  // docker starts a fresh container, so the host directory this pipeline is about would not be in it.
  const dockerStage = spec.stages.find((stage) => stage.runtime?.mode === 'docker');
  if (dockerStage) {
    throw new PipelineSpecError(`Stage ${dockerStage.order} (${dockerStage.role}) uses runtime.mode "docker", which cannot see a worker directory; use "host" for source.kind "worker_workspace"`);
  }
}

/** Single place that decides what "this pipeline works in a worker directory" means. */
export function isWorkspaceSource(source: PipelineSpecDef['source']): boolean {
  return source?.kind === 'worker_workspace';
}
