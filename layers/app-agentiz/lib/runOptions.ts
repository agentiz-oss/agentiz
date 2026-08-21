/**
 * What a manual launch of one task may choose, and what it gets when it chooses nothing.
 *
 * Both surfaces that offer the dialog — the panel and the mobile app — read this one builder, so
 * "что будет использовано" is computed exactly where the snapshot builder resolves it
 * (`AgentPipelineService.buildSnapshot`: the run override wins, then `spec.stages[].model`, then
 * the role) instead of being restated per client and drifting from what actually runs.
 */
import { AgentRole } from '../models/AgentRole';
import { AgentWorker } from '../models/AgentWorker';
import type { AgentTask } from '../models/AgentTask';
import { resolveSpecForTask } from '../services/PipelineSpecResolver';
import {
  harnessKeyForCommand,
  harnessProfile,
  REASONING_LEVEL_TITLES,
  REASONING_LEVELS,
  type HarnessProfile,
} from './harnessCatalog';
import type { PipelineSpecDef, PipelineStageDef } from '../types/agentiz';

export interface RunExecutorOption {
  workerId: string;
  executorKey: string;
  title: string;
  workerName: string;
  /** Normalized harness of that runner's command — what the model list is chosen by. */
  harnessKey: string | null;
}

export interface RunStageOption {
  order: number;
  role: string;
  agentRoleKey: string;
  harnessKey: string | null;
  harnessTitle: string | null;
  model: string | null;
}

export interface RunOptionsView {
  /** What runs if the dialog is submitted untouched, taken from the first LLM stage. */
  defaults: {
    harnessKey: string | null;
    harnessTitle: string | null;
    model: string | null;
    /** No pipeline declares a thinking level today, so an untouched dialog leaves it to the CLI. */
    reasoningLevel: null;
  };
  stages: RunStageOption[];
  executors: RunExecutorOption[];
  harnesses: HarnessProfile[];
  reasoningLevels: Array<{ value: string; title: string }>;
}

function orderedStages(spec: PipelineSpecDef): PipelineStageDef[] {
  return [...(spec.stages ?? [])].sort((a, b) => a.order - b.order);
}

export async function buildRunOptions(task: AgentTask): Promise<RunOptionsView> {
  const spec = await resolveSpecForTask(task);
  const [roles, workers] = await Promise.all([
    AgentRole.findAll({ where: { projectId: task.projectId } }),
    AgentWorker.findAll({ where: { status: 'active' } }),
  ]);
  const roleByKey = new Map(roles.map((role) => [role.key, role]));

  const stages: RunStageOption[] = orderedStages(spec.spec as PipelineSpecDef).map((stage) => {
    const role = roleByKey.get(stage.agentRoleKey);
    const harnessKey = harnessKeyForCommand((role?.config as any)?.acpCommand);
    return {
      order: stage.order,
      role: stage.role,
      agentRoleKey: stage.agentRoleKey,
      harnessKey,
      harnessTitle: harnessProfile(harnessKey)?.title ?? null,
      model: stage.model ?? role?.model ?? null,
    };
  });

  const executors: RunExecutorOption[] = workers
    .filter((worker) => !worker.allowedProjectIds?.length || worker.allowedProjectIds.includes(task.projectId))
    .filter((worker) => {
      const pinned = (spec.spec as PipelineSpecDef).source?.workspace?.workerId;
      return !pinned || pinned === worker.id;
    })
    .flatMap((worker) => (worker.manualExecutors ?? [])
      .filter((executor) => typeof executor?.key === 'string' && !!executor.key.trim()
        && Array.isArray(executor.acpCommand) && executor.acpCommand.length > 0
        && executor.acpCommand.every((part) => typeof part === 'string' && !!part.trim()))
      .map((executor) => ({
        workerId: worker.id,
        executorKey: executor.key,
        title: executor.title || executor.key,
        workerName: worker.name,
        harnessKey: harnessKeyForCommand(executor.acpCommand),
      })));

  // The runner the dialog names by default is the pipeline's own, not a selectable executor: with
  // nothing chosen the run goes through the role's command whether or not any worker declares a
  // manual executor at all.
  const leading = stages.find((stage) => stage.harnessKey) ?? stages[0] ?? null;

  // Both the pipeline's own harness and every offered runner, so the picker can switch its model
  // list when the runner changes without a second request.
  const harnessKeys = [...new Set([
    ...stages.map((stage) => stage.harnessKey),
    ...executors.map((executor) => executor.harnessKey),
  ].filter((key): key is string => !!key))];

  return {
    defaults: {
      harnessKey: leading?.harnessKey ?? null,
      harnessTitle: leading?.harnessTitle ?? null,
      model: leading?.model ?? null,
      reasoningLevel: null,
    },
    stages,
    executors,
    harnesses: harnessKeys.map((key) => harnessProfile(key)!).filter(Boolean),
    reasoningLevels: REASONING_LEVELS.map((value) => ({ value, title: REASONING_LEVEL_TITLES[value] })),
  };
}
