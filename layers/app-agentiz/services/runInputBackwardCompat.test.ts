import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { HOOK_VARIABLE_NAMES, buildHookEnv } from '../lib/hookEnv';
import type { AgentProject } from '../models/AgentProject';
import type { AgentRun } from '../models/AgentRun';
import type { AgentTask } from '../models/AgentTask';

/**
 * `AgentRun.input` → `AGENTIZ_WORKFLOW_INPUT`, walked from the shape a pipeline written **before**
 * the field existed produces, per the rule in AGENTS.md: extending the snapshot has to prove the
 * old pipelines are untouched, not merely that the new one works.
 *
 * The failure this guards against is specific and would be silent: a hook script is a program
 * somebody wrote against an environment they enumerated once. A new variable that appears
 * unconditionally — even empty — changes `env | wc -l`, changes `set -u` behaviour for a script
 * that tests `[ -z "${AGENTIZ_WORKFLOW_INPUT}" ]`, and changes nothing that any test would notice
 * unless a test asks for the whole set. So this one asks for the whole set.
 */

/** Just enough of each row for `buildHookEnv`; it reads plain fields and nothing else. */
function fixture(input: Record<string, unknown> | null) {
  return {
    run: { id: 'run-1', input } as unknown as AgentRun,
    task: {
      id: 'task-1',
      externalId: 'local:1',
      title: 'Кнопки должны работать с клавиатуры',
      tags: ['фича'],
      externalUrl: null,
      branchRef: null,
    } as unknown as AgentTask,
    project: { id: 'project-1', slug: 'lyapka-rf' } as unknown as AgentProject,
    stageCount: 1,
    repository: null as null,
    workspace: { key: 'lyapka-rf', path: '/prj/lyapka-rf' },
  };
}

describe('AGENTIZ_WORKFLOW_INPUT: старые пайплайны не должны заметить нового поля', () => {
  it('запуск без input отдаёт ровно тот же набор переменных, что и раньше', () => {
    const env = buildHookEnv(fixture(null));
    // The full set a `worker_workspace` pipeline saw before this field existed, spelled out rather
    // than derived — a list computed from the catalogue would pass no matter what the catalogue says.
    expect(Object.keys(env).sort()).toEqual([
      'AGENTIZ_PIPELINE_SOURCE',
      'AGENTIZ_PROJECT_ID',
      'AGENTIZ_PROJECT_SLUG',
      'AGENTIZ_RUN_ID',
      'AGENTIZ_STAGE_COUNT',
      'AGENTIZ_TASK_BRANCH',
      'AGENTIZ_TASK_EXTERNAL_ID',
      'AGENTIZ_TASK_ID',
      'AGENTIZ_TASK_TAGS',
      'AGENTIZ_TASK_TITLE',
      'AGENTIZ_TASK_URL',
      'AGENTIZ_WORKSPACE_KEY',
      'AGENTIZ_WORKSPACE_PATH',
    ]);
    expect('AGENTIZ_WORKFLOW_INPUT' in env).toBe(false);
  });

  it('пустой объект — это тоже «ничего не передали»', () => {
    // A node that passes an empty payload must not be the reason a script starts seeing the
    // variable; "передали пустое" and "не передали" are the same fact to a hook.
    expect('AGENTIZ_WORKFLOW_INPUT' in buildHookEnv(fixture({}))).toBe(false);
  });

  it('переданный input приезжает как json и ничего больше не трогает', () => {
    const withInput = buildHookEnv(fixture({ branches: ['agentiz/one', 'agentiz/two'], count: 2 }));
    const without = buildHookEnv(fixture(null));

    expect(JSON.parse(withInput.AGENTIZ_WORKFLOW_INPUT)).toEqual({
      branches: ['agentiz/one', 'agentiz/two'],
      count: 2,
    });
    const { AGENTIZ_WORKFLOW_INPUT: _ignored, ...rest } = withInput;
    expect(rest).toEqual(without);
  });

  it('значения едут как данные, а не как текст скрипта', () => {
    // Branch names come from the outside. The whole reason values travel as environment variables
    // is that nothing substitutes them into the script — so a name that looks like a command has to
    // survive as a name.
    const nasty = buildHookEnv(fixture({ branches: ['agentiz/"; rm -rf ~; #'] }));
    expect(JSON.parse(nasty.AGENTIZ_WORKFLOW_INPUT).branches[0]).toBe('agentiz/"; rm -rf ~; #');
  });

  it('переменная объявлена в каталоге — иначе редактор хуков подчеркнёт её как опечатку', () => {
    expect(HOOK_VARIABLE_NAMES.has('AGENTIZ_WORKFLOW_INPUT')).toBe(true);
  });
});
