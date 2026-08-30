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
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../models';
import { AgentProject } from '../models/AgentProject';
import { AgentRun } from '../models/AgentRun';
import { AgentStageExecution } from '../models/AgentStageExecution';
import { AgentTask } from '../models/AgentTask';
import { resolveRunVerdict } from './AgentWorkerApiService';

/**
 * `resolveRunVerdict` reads the marker only off the stages the spec asked one of, matched by
 * `AgentStageExecution.stageIndex` — never off `resultSummary`'s combined text, and never off a
 * stage that never set `verdict: true`, even when that stage's text happens to look like one.
 */
describe('resolveRunVerdict', () => {
  let sequelize: Sequelize;
  let project: AgentProject;
  let task: AgentTask;

  const stages = [
    { order: 1, role: 'implement', agentRoleKey: 'implementer', onFail: 'stop' as const, runtime: { mode: 'host' as const } },
    { order: 2, role: 'test', agentRoleKey: 'tester', onFail: 'stop' as const, verdict: true, runtime: { mode: 'host' as const } },
  ];

  beforeAll(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, models: Object.values(agentizModels) as any[] });
  });

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    project = await AgentProject.create({ name: 'Test', slug: 'test', ownerId: 1 } as any);
    task = await AgentTask.create({ projectId: project.id, externalId: 'local:1', title: 'Fix', status: 'running', priority: 'normal' } as any);
  });

  afterAll(async () => sequelize.close());

  async function runWithStages() {
    const run = await AgentRun.create({
      projectId: project.id, taskId: task.id, status: 'running', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages, finalAction: { type: 'none' } },
    } as any);
    const [implement, test] = await Promise.all([
      AgentStageExecution.create({ runId: run.id, stageIndex: 0, role: 'implement', status: 'succeeded' } as any),
      AgentStageExecution.create({ runId: run.id, stageIndex: 1, role: 'test', status: 'succeeded' } as any),
    ]);
    return { run, implement, test };
  }

  it('reads the marker off the verdict stage output', async () => {
    const { run, implement, test } = await runWithStages();
    const result = await resolveRunVerdict(run, [
      { executionId: implement.id, status: 'succeeded', summary: 'done' },
      { executionId: test.id, status: 'succeeded', output: { agentResponse: 'All green.\nAGENTIZ_VERDICT: pass' } },
    ]);
    expect(result).toEqual({ verdict: 'pass', verdictReason: null });
  });

  it('ignores a marker-shaped line in a stage that never asked for one', async () => {
    const { run, implement, test } = await runWithStages();
    const result = await resolveRunVerdict(run, [
      // Not a verdict stage — quoting the format must not produce a false verdict.
      { executionId: implement.id, status: 'succeeded', output: { agentResponse: 'Reviewer wrote AGENTIZ_VERDICT: fail — nope' } },
      { executionId: test.id, status: 'succeeded', output: { agentResponse: 'No marker in this answer.' } },
    ]);
    expect(result).toEqual({ verdict: null, verdictReason: null });
  });

  it('falls back to summary when output.agentResponse is absent', async () => {
    const { run, implement, test } = await runWithStages();
    const result = await resolveRunVerdict(run, [
      { executionId: implement.id, status: 'succeeded', summary: 'done' },
      { executionId: test.id, status: 'succeeded', summary: 'AGENTIZ_VERDICT: fail — broken build' },
    ]);
    expect(result).toEqual({ verdict: 'fail', verdictReason: 'broken build' });
  });

  it('returns null when no stage output carries a usable marker', async () => {
    const { run, implement, test } = await runWithStages();
    const result = await resolveRunVerdict(run, [
      { executionId: implement.id, status: 'succeeded', summary: 'done' },
      { executionId: test.id, status: 'succeeded', output: { agentResponse: 'AGENTIZ_VERDICT: unclear' } },
    ]);
    expect(result).toEqual({ verdict: null, verdictReason: null });
  });

  it('returns null with no stageOutputs at all', async () => {
    const { run } = await runWithStages();
    expect(await resolveRunVerdict(run, undefined)).toEqual({ verdict: null, verdictReason: null });
    expect(await resolveRunVerdict(run, [])).toEqual({ verdict: null, verdictReason: null });
  });
});
