import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
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
}
