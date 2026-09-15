/**
 * The regression guard for the panel's pipeline editor.
 *
 * `AGENTS.md` states the rule this file is an instance of: extending a pipeline spec has to prove
 * that **yesterday's pipelines keep working**, not only that the new thing works. The stage that
 * rewrote the editor extends nothing in the spec — but it rewrites the code that *assembles* one,
 * which puts exactly the same question on the table from the other side: a spec that goes through
 * the new editor has to come out byte-identical unless a person changed something, with no field
 * defaulted in, no unknown key dropped and no absent value turned into `null`.
 *
 * `services/pipelineVerdictBackwardCompat.test.ts` is the worked example this follows: one file
 * that walks legacy-shaped documents through the whole path instead of leaving the answer to be
 * inferred from four unrelated tests. The path here is `lib/pipelineDraft.ts` (the draft algebra
 * the screen is built out of) plus `assertValidSpec`, which is what the four write paths all end
 * at — so a divergence shows up as a failing expectation rather than as a pipeline behaving
 * differently a week later.
 *
 * Three shapes are checked against, and the second is the interesting one:
 *   - `legacySpec` — the minimum a spec has ever been allowed to be;
 *   - `richSpec` — every optional key the schema allows, **including the ones this editor has no
 *     control for** (`constraints`, `source.branch`, `finalAction.pullRequestTitleTemplate`,
 *     `stage.onFail`). Those are what a form-shaped editor silently eats;
 *   - `workspaceSpec` — the `worker_workspace` half, whose source block has its own rules.
 */
import { describe, expect, it } from 'vitest';
import {
  addStage,
  moveStage,
  pipelineDraft,
  removeStage,
  sameDocument,
  sourceKindOf,
  verdictStageCount,
  withFinalAction,
  withHook,
  withHumanCommentTrigger,
  withRepositorySource,
  withStage,
  withStageRuntime,
  withStashDirty,
  withWorkspaceDelivery,
  withWorkspaceRepository,
  withWorkspaceSource,
  type PipelineDoc,
} from '../lib/pipelineDraft';
import { pipelineRowPatch } from '../lib/panel/pipelinesPanel';
import { assertValidSpec } from './PipelineSpecValidation';

/** Exactly what a spec was allowed to be before any optional key existed. */
const legacySpec: PipelineDoc = {
  stages: [{ order: 1, role: 'implement', agentRoleKey: 'implementer', runtime: { mode: 'host' } }],
  finalAction: { type: 'comment_only' },
};

/** Every optional key the schema allows, several of which this editor draws no control for. */
const richSpec: PipelineDoc = {
  stages: [
    {
      order: 1,
      role: 'investigate',
      agentRoleKey: 'analyst',
      onFail: 'continue',
      runtime: { mode: 'docker' },
    },
    {
      order: 2,
      role: 'check',
      agentRoleKey: 'tester',
      model: 'claude-opus-5',
      verdict: true,
      onFail: 'stop',
      runtime: { mode: 'host' },
    },
  ],
  finalAction: {
    type: 'commit_and_pr',
    requireApproval: true,
    branchPrefix: 'agentiz/',
    commitMessageTemplate: '{{title}}',
    pullRequestTitleTemplate: '{{externalId}}: {{title}}',
  },
  source: {
    kind: 'repository',
    repositoryId: 'repo-1',
    branch: 'develop',
    allowTaskOverride: false,
  },
  hooks: {
    before: { interpreter: 'bash', script: 'npm ci', timeoutSec: 900, onFail: 'continue' },
  },
  triggers: { humanComment: true },
  constraints: {
    priority: 50,
    activeHours: {
      timezone: 'Europe/Belgrade',
      windows: [{ days: ['mon', 'tue'], start: '09:00', end: '18:00' }],
      enforcement: 'start-only',
    },
  },
};

const workspaceSpec: PipelineDoc = {
  stages: [{ order: 1, role: 'build', agentRoleKey: 'builder', runtime: { mode: 'host' } }],
  finalAction: { type: 'comment_only' },
  source: {
    kind: 'worker_workspace',
    workspace: { workerId: 'worker-1', workspaceKey: 'monorepo' },
  },
};

const SHAPES: Array<[string, PipelineDoc]> = [
  ['минимальная спека', legacySpec],
  ['спека со всеми необязательными полями', richSpec],
  ['спека, работающая в папке воркера', workspaceSpec],
];

/** What the editor would POST: the draft, serialized exactly as `axios` serializes it. */
function wire(doc: PipelineDoc): string {
  return JSON.stringify(doc);
}

describe('pipeline editor: a spec nobody edited comes out byte-identical', () => {
  for (const [name, spec] of SHAPES) {
    it(`${name} — открыть и сохранить, ничего не тронув`, () => {
      const draft = pipelineDraft(spec);
      expect(wire(draft)).toBe(wire(spec));
      // …and the server still accepts it, with the same verdict it gave the stored document.
      expect(() => assertValidSpec(spec)).not.toThrow();
      expect(() => assertValidSpec(draft)).not.toThrow();
      expect(sameDocument(draft, spec)).toBe(true);
    });
  }

  it('черновик — самостоятельная копия: правка в нём не трогает сохранённый документ', () => {
    const saved = pipelineDraft(richSpec);
    const draft = pipelineDraft(saved);
    const edited = withStage(draft, 0, { model: 'gpt-5.5' });
    expect(edited.stages[0].model).toBe('gpt-5.5');
    expect(saved.stages[0].model).toBeUndefined();
    // «Отменить» is `setDraft(saved)`, so the saved copy has to be the document it was.
    expect(wire(saved)).toBe(wire(richSpec));
  });
});

/**
 * The failure mode a form-shaped editor has and this one must not: a `<select>` whose value is a
 * computed default fires its change handler with that default, so merely *opening* a screen would
 * write a field a legacy spec never had.
 */
describe('pipeline editor: setting the value that is already there writes nothing', () => {
  it('выбор того же режима этапа не добавляет ключей', () => {
    const doc = pipelineDraft(legacySpec);
    expect(wire(withStageRuntime(doc, 0, 'host'))).toBe(wire(legacySpec));
    expect(wire(withStage(doc, 0, { agentRoleKey: 'implementer' }))).toBe(wire(legacySpec));
  });

  it('пустое поле модели не превращается в null и не заводит ключ', () => {
    const doc = pipelineDraft(legacySpec);
    const touched = withStage(doc, 0, { model: undefined });
    expect(wire(touched)).toBe(wire(legacySpec));
    expect('model' in touched.stages[0]).toBe(false);
  });

  it('выключенный вердикт остаётся отсутствующим, а не false', () => {
    const doc = pipelineDraft(legacySpec);
    const off = withStage(doc, 0, { verdict: undefined });
    expect(wire(off)).toBe(wire(legacySpec));
    expect(verdictStageCount(off)).toBe(0);
    // Switching it on and off again returns the stage to the shape it had.
    const on = withStage(doc, 0, { verdict: true });
    expect(verdictStageCount(on)).toBe(1);
    expect(wire(withStage(on, 0, { verdict: undefined }))).toBe(wire(legacySpec));
  });

  it('выключенный триггер комментария не заводит объект triggers', () => {
    const doc = pipelineDraft(legacySpec);
    expect(wire(withHumanCommentTrigger(doc, false))).toBe(wire(legacySpec));
    const on = withHumanCommentTrigger(doc, true);
    expect(on.triggers).toEqual({ humanComment: true });
    expect(wire(withHumanCommentTrigger(on, false))).toBe(wire(legacySpec));
  });

  it('«репозиторий» на спеке без source не заводит source', () => {
    // Absent `source` already means repository. Storing `{kind: "repository"}` would be a new key
    // saying exactly what its absence said, and the schema would accept it — silently.
    const doc = pipelineDraft(legacySpec);
    expect(wire(withRepositorySource(doc, undefined))).toBe(wire(legacySpec));
    expect(sourceKindOf(doc)).toBe('repository');
  });

  it('«убирать чужие изменения в stash» по умолчанию ничего не пишет', () => {
    const doc = pipelineDraft(workspaceSpec);
    expect(wire(withStashDirty(doc, true))).toBe(wire(workspaceSpec));
    const refuse = withStashDirty(doc, false);
    expect(refuse.source?.workspace?.stashDirty).toBe(false);
    expect(wire(withStashDirty(refuse, true))).toBe(wire(workspaceSpec));
  });

  it('выбор уже выбранной доставки не переписывает finalAction', () => {
    const doc = pipelineDraft(workspaceSpec);
    expect(wire(withWorkspaceDelivery(doc, 'comment_only'))).toBe(wire(workspaceSpec));
  });

  it('снятый хук не оставляет пустого объекта hooks', () => {
    const doc = pipelineDraft(legacySpec);
    expect(wire(withHook(doc, 'before', undefined))).toBe(wire(legacySpec));
    const added = withHook(doc, 'before', { interpreter: 'bash', script: 'npm ci' });
    expect(wire(withHook(added, 'before', undefined))).toBe(wire(legacySpec));
  });
});

describe('pipeline editor: a real edit keeps everything it does not know about', () => {
  it('правка модели этапа не трогает constraints, ветку источника и шаблон PR', () => {
    const edited = withStage(pipelineDraft(richSpec), 1, { model: 'gpt-5.5' });
    expect(edited.constraints).toEqual(richSpec.constraints);
    expect(edited.source).toEqual(richSpec.source);
    expect(edited.finalAction).toEqual(richSpec.finalAction);
    expect(edited.stages[0]).toEqual(richSpec.stages[0]);
    // Only the one field moved, and the stage's own unknown keys came along.
    expect(edited.stages[1]).toEqual({ ...richSpec.stages[1], model: 'gpt-5.5' });
    expect(() => assertValidSpec(edited)).not.toThrow();
  });

  it('переключение источника на репозиторий сохраняет ветку и allowTaskOverride', () => {
    const edited = withRepositorySource(pipelineDraft(richSpec), 'repo-2');
    expect(edited.source).toEqual({ ...richSpec.source, repositoryId: 'repo-2' });
    expect(() => assertValidSpec(edited)).not.toThrow();
  });

  it('правка finalAction не выбрасывает шаблоны, которых у редактора нет полей', () => {
    const edited = withFinalAction(pipelineDraft(richSpec), { requireApproval: false });
    expect(edited.finalAction.pullRequestTitleTemplate).toBe('{{externalId}}: {{title}}');
    expect(edited.finalAction.branchPrefix).toBe('agentiz/');
    expect(edited.finalAction.requireApproval).toBe(false);
  });

  it('правка одного хука не трогает второй и не теряет таймаут', () => {
    const edited = withHook(pipelineDraft(richSpec), 'after', { interpreter: 'node', script: 'process.exit(0)' });
    expect(edited.hooks?.before).toEqual(richSpec.hooks?.before);
    expect(edited.hooks?.after).toEqual({ interpreter: 'node', script: 'process.exit(0)' });
    expect(() => assertValidSpec(edited)).not.toThrow();
  });
});

describe('pipeline editor: the stage list stays a legal one', () => {
  const three: PipelineDoc = {
    stages: [
      { order: 1, role: 'a', agentRoleKey: 'r1', runtime: { mode: 'host' } },
      { order: 2, role: 'b', agentRoleKey: 'r2', runtime: { mode: 'host' } },
      { order: 3, role: 'c', agentRoleKey: 'r3', runtime: { mode: 'host' } },
    ],
    finalAction: { type: 'none' },
  };

  it('перестановка перенумеровывает order в 1..N', () => {
    const moved = moveStage(pipelineDraft(three), 2, -1);
    expect(moved.stages.map((stage) => [stage.order, stage.role])).toEqual([[1, 'a'], [2, 'c'], [3, 'b']]);
    expect(() => assertValidSpec(moved)).not.toThrow();
  });

  it('удаление не оставляет дыры в нумерации и не опустошает список', () => {
    const shorter = removeStage(pipelineDraft(three), 0);
    expect(shorter.stages.map((stage) => [stage.order, stage.role])).toEqual([[1, 'b'], [2, 'c']]);
    expect(() => assertValidSpec(shorter)).not.toThrow();
    // The schema needs at least one stage, so the last one refuses to go.
    const one = removeStage(removeStage(shorter, 0), 0);
    expect(one.stages).toHaveLength(1);
  });

  it('добавленный этап валиден и не ломает соседей', () => {
    const longer = addStage(pipelineDraft(three), 'r4', 'review');
    expect(longer.stages).toHaveLength(4);
    expect(longer.stages[3]).toEqual({ order: 4, role: 'review', agentRoleKey: 'r4', runtime: { mode: 'host' } });
    expect(longer.stages.slice(0, 3)).toEqual(three.stages);
    expect(() => assertValidSpec(longer)).not.toThrow();
  });

  it('перестановка, возвращённая обратно, даёт исходный документ', () => {
    const doc = pipelineDraft(three);
    expect(wire(moveStage(moveStage(doc, 0, 1), 1, -1))).toBe(wire(three));
  });
});

describe('pipeline editor: the worker_workspace half', () => {
  it('смена папки сохраняет stashDirty, который оператор уже выключил', () => {
    const doc = withStashDirty(pipelineDraft(workspaceSpec), false);
    const moved = withWorkspaceSource(doc, { workerId: 'worker-1', workspaceKey: 'other' }, false);
    expect(moved.source?.workspace).toEqual({ workerId: 'worker-1', workspaceKey: 'other', stashDirty: false });
    expect(() => assertValidSpec(moved)).not.toThrow();
  });

  it('папка называется ровно одним способом: ключ вытесняет путь и наоборот', () => {
    const byPath = withWorkspaceSource(pipelineDraft(workspaceSpec), { workerId: 'worker-1', path: '/srv/app' }, false);
    expect(byPath.source?.workspace).toEqual({ workerId: 'worker-1', path: '/srv/app' });
    const byKey = withWorkspaceSource(byPath, { workerId: 'worker-1', workspaceKey: 'monorepo' }, false);
    expect(byKey.source?.workspace).toEqual({ workerId: 'worker-1', workspaceKey: 'monorepo' });
    expect(() => assertValidSpec(byPath)).not.toThrow();
    expect(() => assertValidSpec(byKey)).not.toThrow();
  });

  it('commit_and_pr не переживает переезд в папку воркера — его там некому выполнить', () => {
    const repository: PipelineDoc = { ...richSpec, source: { kind: 'repository' } };
    const moved = withWorkspaceSource(repository, { workerId: 'worker-1', workspaceKey: 'monorepo' }, true);
    expect(moved.finalAction.type).toBe('comment_only');
    // The same move drops docker: a container cannot see the worker's directory, and leaving the
    // stage as it was would make the save fail naming a stage nobody was editing. Found by this
    // test, not by a person — the previous editor produced exactly that document.
    expect(moved.stages.map((stage) => stage.runtime?.mode)).toEqual(['host', 'host']);
    expect(moved.stages[1]).toEqual(richSpec.stages[1]);
    expect(() => assertValidSpec(moved)).not.toThrow();
  });

  it('этапы, уже стоящие на host, переезд не трогает', () => {
    const doc = pipelineDraft(workspaceSpec);
    const moved = withWorkspaceSource(doc, { workerId: 'worker-1', workspaceKey: 'monorepo' }, false);
    expect(wire(moved)).toBe(wire(workspaceSpec));
  });

  it('commit переживает переезд, только если воркер разрешает push из новой папки', () => {
    const committing = withWorkspaceDelivery(pipelineDraft(workspaceSpec), 'commit');
    expect(committing.finalAction.type).toBe('commit');

    const allowed = withWorkspaceSource(committing, { workerId: 'worker-1', path: '/srv/app' }, true);
    expect(allowed.finalAction.type).toBe('commit');

    const refused = withWorkspaceSource(committing, { workerId: 'worker-2', path: '/home/other' }, false);
    expect(refused.finalAction.type).toBe('comment_only');
    expect(() => assertValidSpec(refused)).not.toThrow();
  });

  it('репозиторий доставки отваливается вместе с понижением до комментария', () => {
    const pinned = withWorkspaceRepository(withWorkspaceDelivery(pipelineDraft(workspaceSpec), 'commit'), 'repo-1');
    expect(pinned.source?.repositoryId).toBe('repo-1');
    // `source.repositoryId` is only accepted beside a workspace `commit`, so a downgrade that left
    // it behind would produce a document the server rejects.
    const downgraded = withWorkspaceSource(pinned, { workerId: 'worker-2', path: '/home/other' }, false);
    expect(downgraded.source?.repositoryId).toBeUndefined();
    expect(() => assertValidSpec(downgraded)).not.toThrow();
  });
});

/**
 * The columns beside the document. The previous editor never sent any of them, so the patch a body
 * without them produces has to be empty — otherwise every save from an older client would start
 * rewriting a name.
 */
describe('updatePipelineSpec: which columns a body is allowed to move', () => {
  it('тело прежнего редактора не трогает ни одной колонки, кроме spec', () => {
    expect(pipelineRowPatch({ _method: 'updatePipelineSpec', specId: 's1', spec: legacySpec })).toEqual({});
    expect(pipelineRowPatch(undefined)).toEqual({});
    expect(pipelineRowPatch({})).toEqual({});
  });

  it('projectId не переносится никогда — модель всё равно откажет', () => {
    expect(pipelineRowPatch({ specId: 's1', projectId: 'other-project' })).toEqual({});
  });

  it('пустые теги сохраняются как отсутствие тегов, а не как пустой список', () => {
    expect(pipelineRowPatch({ matchTags: [] })).toEqual({ matchTags: null });
    expect(pipelineRowPatch({ matchTags: ['bug', ' urgent ', ''] })).toEqual({ matchTags: ['bug', 'urgent'] });
  });

  it('пустое имя не стирает название', () => {
    expect(pipelineRowPatch({ name: '   ' })).toEqual({});
    expect(pipelineRowPatch({ name: ' Фича ' })).toEqual({ name: 'Фича' });
  });

  it('активность переносится только настоящим булевым значением', () => {
    expect(pipelineRowPatch({ isActive: false })).toEqual({ isActive: false });
    expect(pipelineRowPatch({ isActive: 'false' })).toEqual({});
  });
});
