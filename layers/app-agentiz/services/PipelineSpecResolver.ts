import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction, ErrorObject } from 'ajv';
import { PipelineSpec } from '../models/PipelineSpec';
import { AgentTask } from '../models/AgentTask';
import type { PipelineSpecDef } from '../types/agentiz';

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
 * Validates a spec document against schemas/pipeline-spec.schema.json plus the rules the schema
 * itself cannot express (unique, gap-free stage ordering).
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
}

/** Stages sorted by `order`, so callers never depend on the array's stored ordering. */
export function orderedStages(spec: PipelineSpecDef) {
  return [...spec.stages].sort((a, b) => a.order - b.order);
}

/**
 * "К нам в проект прилетела задача с определённым тегом" — pick the spec by tag, and fall back to
 * the project's default spec when nothing matches. The most specific match wins: among the specs
 * whose matchTags intersect the task's tags, the one with the most matching tags is used.
 */
export async function resolveSpecForTask(task: AgentTask): Promise<PipelineSpec> {
  const specs = await PipelineSpec.findAll({
    where: { projectId: task.projectId, isActive: true },
    order: [['createdAt', 'ASC']],
  });
  if (specs.length === 0) {
    throw new PipelineSpecError(`No active pipeline spec for project ${task.projectId}`);
  }

  const taskTags = new Set((task.tags ?? []).map((tag) => String(tag).toLowerCase()));

  let best: { spec: PipelineSpec; score: number } | null = null;
  for (const spec of specs) {
    if (spec.isDefault) continue;
    const specTags = (spec.matchTags ?? []).map((tag) => String(tag).toLowerCase());
    if (specTags.length === 0) continue;
    const score = specTags.filter((tag) => taskTags.has(tag)).length;
    if (score > 0 && (!best || score > best.score)) {
      best = { spec, score };
    }
  }
  if (best) {
    assertValidSpec(best.spec.spec);
    return best.spec;
  }

  const fallback = specs.find((spec) => spec.isDefault);
  if (!fallback) {
    throw new PipelineSpecError(
      `No pipeline spec matched tags [${[...taskTags].join(', ') || 'none'}] and project ${task.projectId} has no default spec`,
    );
  }
  assertValidSpec(fallback.spec);
  return fallback;
}
