/**
 * The regression guard for `stages[].verdict` (`.ai-notes/machine-verdict-plan.md`): a
 * `PipelineSpec` written before this field existed must produce byte-identical behaviour after it
 * landed — same validation result, same prompt, `AgentRun.verdict` staying `null`, same workflow
 * port. Each layer the field touches already carries its own focused test (schema validation in
 * `PipelineSpecValidation.test.ts`, the prompt in `AgentPipelineService.test.ts`, marker parsing in
 * `AgentWorkerApiService.verdict.test.ts`), but none of those is *labelled* as "does this break
 * yesterday's pipelines" — this file is that label, walking one legacy-shaped spec through every
 * layer in one place so the question has one obvious answer instead of four scattered ones.
 *
 * See the AGENTS.md bullet "Extending a pipeline spec/snapshot/prompt" for the rule this file is
 * an instance of: any future field on `stages[]` needs the same kind of test, and a deviation found
 * here is a bug to raise, never a behaviour to silently accept.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
  AbstractNotificationService: class {
    protected adminizer: any;
    constructor(adminizer: any) {
      this.adminizer = adminizer;
    }
  },
}));
// Not the real engine: engineBridge's only job here is picking `output`, and pulling in the real
// `@nodeknit/app-workflow` build would make this file hostage to that package's own install state.
const completeExternal = vi.fn();
vi.mock('@nodeknit/app-workflow', () => ({
  getWorkflowEngine: () => ({ completeExternal }),
  WorkflowAdminApi: class {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../models';
import { AgentProject } from '../models/AgentProject';
import { AgentRole } from '../models/AgentRole';
import { AgentRun } from '../models/AgentRun';
import { AgentStageExecution } from '../models/AgentStageExecution';
import { AgentTask } from '../models/AgentTask';
import { assertValidSpec } from './PipelineSpecValidation';
import { AgentWorkerJobBuilder } from './AgentPipelineService';
import { resolveRunVerdict } from './AgentWorkerApiService';
import { completePipelineWait } from '../lib/workflow/engineBridge';

/** A spec exactly as it would have been written before `stages[].verdict` existed: no such key. */
const legacySpec = {
  stages: [
    { order: 1, role: 'implement', agentRoleKey: 'implementer', onFail: 'stop', runtime: { mode: 'host' } },
  ],
  finalAction: { type: 'none' },
};

describe('backward compatibility: pipelines written before stage.verdict existed', () => {
  it('still validates against the schema — no verdict key anywhere is not a rejection', () => {
    expect(() => assertValidSpec(legacySpec)).not.toThrow();
  });

  describe('server-side behaviour (buildSnapshot, marker parsing, workflow routing)', () => {
    let sequelize: Sequelize;
    let project: AgentProject;
    let task: AgentTask;

    beforeAll(async () => {
      sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, models: Object.values(agentizModels) as any[] });
    });

    beforeEach(async () => {
      await sequelize.sync({ force: true });
      project = await AgentProject.create({ name: 'Test', slug: 'test', ownerId: 1 } as any);
      task = await AgentTask.create({ projectId: project.id, externalId: 'local:1', title: 'Fix', status: 'running', priority: 'normal' } as any);
      await AgentRole.create({ projectId: project.id, key: 'implementer', title: 'Implementer', systemPrompt: 'You implement things.' } as any);
    });

    afterAll(async () => sequelize.close());

    it('buildSnapshot leaves the prompt untouched and marks the stage verdict:false', async () => {
      const run = await AgentRun.create({
        projectId: project.id, taskId: task.id, status: 'pending', trigger: 'manual', currentStageIndex: 0,
        pipelineSnapshot: legacySpec,
      } as any);
      const snapshot = await AgentWorkerJobBuilder.buildSnapshot(run) as any;
      expect(snapshot.stages[0].verdict).toBe(false);
      // No instruction appended — exactly the role's own prompt, not a superstring of it.
      expect(snapshot.stages[0].systemPrompt).toBe('You implement things.');
    });

    it('resolveRunVerdict never produces a verdict for a legacy spec, even if the agent\'s free '
      + 'text happens to contain a marker-shaped line', async () => {
      const run = await AgentRun.create({
        projectId: project.id, taskId: task.id, status: 'running', trigger: 'manual', currentStageIndex: 0,
        pipelineSnapshot: legacySpec,
      } as any);
      const execution = await AgentStageExecution.create({ runId: run.id, stageIndex: 0, role: 'implement', status: 'succeeded' } as any);
      const result = await resolveRunVerdict(run, [
        { executionId: execution.id, status: 'succeeded', output: { agentResponse: 'Done.\nAGENTIZ_VERDICT: pass' } },
      ]);
      expect(result).toEqual({ verdict: null, verdictReason: null });
    });

    it('a terminal run with no verdict still routes the workflow on succeeded/failed, exactly as before this field existed', async () => {
      completeExternal.mockClear();
      await completePipelineWait('run-legacy-1', { status: 'succeeded', taskId: task.id, projectId: project.id, summary: 'done' });
      expect(completeExternal).toHaveBeenCalledTimes(1);
      expect(completeExternal.mock.calls[0][1].output).toBe('succeeded');

      completeExternal.mockClear();
      await completePipelineWait('run-legacy-2', { status: 'failed', taskId: task.id, projectId: project.id, error: 'boom' });
      expect(completeExternal.mock.calls[0][1].output).toBe('failed');
    });
  });
});

/**
 * The other half of the same guarantee: a verdict, when present, must never leak onto the old
 * ports in a way old graphs didn't expect — `pass`/`fail` only fire when the pipeline actually
 * asked, and `failed` stays reserved for an infrastructure failure even if a verdict is attached.
 */
describe('the new field only adds behaviour — it never repurposes the old ports', () => {
  beforeEach(() => completeExternal.mockClear());

  it('verdict overrides succeeded, not failed', async () => {
    await completePipelineWait('run-v1', { status: 'succeeded', verdict: 'fail', taskId: 't', projectId: 'p' });
    expect(completeExternal.mock.calls[0][1].output).toBe('fail');
  });

  it('an infrastructure failure stays on "failed" even if a verdict was somehow attached', async () => {
    await completePipelineWait('run-v2', { status: 'failed', verdict: 'pass', taskId: 't', projectId: 'p' });
    expect(completeExternal.mock.calls[0][1].output).toBe('failed');
  });
});
