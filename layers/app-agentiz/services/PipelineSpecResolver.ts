import { PipelineSpec } from '../models/PipelineSpec';
import { AgentTask } from '../models/AgentTask';
import type { PipelineSpecDef } from '../types/agentiz';
import { assertValidSpec, PipelineSpecError } from './PipelineSpecValidation';

export { assertValidSpec, isWorkspaceSource, PipelineSpecError } from './PipelineSpecValidation';

/** Stages sorted by `order`, so callers never depend on the array's stored ordering. */
export function orderedStages(spec: PipelineSpecDef) {
  return [...spec.stages].sort((a, b) => a.order - b.order);
}

/**
 * The spec a caller named explicitly — a workflow node's `specId`, an operator's choice.
 *
 * Scoped to the task's own project on purpose, and refused otherwise: a `PipelineSpec` is an
 * entity of *its* project and never moves (see the `@BeforeSave` on the model), so naming one
 * across the boundary would be the one hole that discipline exists to close. `isActive` is
 * deliberately **not** required — a person who wired a specific spec into a graph named that spec,
 * and silently falling back to tag resolution would run something else under its name.
 */
export async function resolveSpecById(task: AgentTask, specId: string): Promise<PipelineSpec> {
  const spec = await PipelineSpec.findByPk(specId);
  if (!spec || spec.projectId !== task.projectId) {
    throw new PipelineSpecError(
      `Pipeline spec ${specId} does not belong to project ${task.projectId} of task ${task.id}`,
    );
  }
  assertValidSpec(spec.spec);
  return spec;
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
