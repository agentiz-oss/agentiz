/**
 * The pipeline spec document, as an editor changes it.
 *
 * `PipelineSpec.spec` is stored and shipped as **one** JSON document, and every write path sends
 * it whole (`updatePipelineSpec`). An editor therefore has two possible shapes, and only one of
 * them is safe: read the document into form fields and serialize them back (which silently drops
 * every key the form does not know and writes a default for every key it does), or keep the stored
 * document itself as the draft and apply narrow patches to it. This module is the second shape,
 * and it is the whole reason it exists as a file of its own rather than as helpers inside the
 * screen: the guarantee «спека, прошедшая через редактор без единой правки, выходит прежней» is a
 * property of these functions, so it can be tested without a browser
 * (`services/pipelineEditorBackwardCompat.test.ts`).
 *
 * Three rules hold that guarantee up, and every function here obeys all three:
 *
 *   1. **Unknown keys travel.** A patch spreads the existing object; it never rebuilds one from a
 *      known field list. That is what keeps `constraints`, `source.branch`,
 *      `finalAction.pullRequestTitleTemplate` and anything added tomorrow alive through an edit
 *      made by a screen that has never heard of them.
 *   2. **`undefined` deletes, it does not store.** Absent and `null` are different documents to
 *      the schema (`additionalProperties: false` plus per-field defaults), and «выключено» for an
 *      optional flag means *absent*, not `false` — otherwise the first toggle of a control the
 *      operator never touched would rewrite a legacy spec.
 *   3. **Setting the value that is already there changes nothing.** A `<select>` whose value is a
 *      computed default (`runtime.mode ?? ''`) fires its change handler with that default; if a
 *      patch stored it, opening a screen would be enough to alter a spec.
 *
 * Deliberately free of imports, `process` and `window`, like `routeTree.ts`: Vite bundles it into
 * the browser module and vitest runs the same source on the server.
 */

/** One stage. The index signature is the contract, not laziness: unknown keys are carried. */
export interface PipelineStageDoc {
  order: number;
  role: string;
  agentRoleKey: string;
  /** Overrides the role's model for this stage only; absent = the role's own. */
  model?: string;
  onFail?: 'stop' | 'continue';
  verdict?: boolean;
  runtime?: { mode?: 'host' | 'docker'; [key: string]: unknown };
  [key: string]: unknown;
}

export interface PipelineWorkspaceDoc {
  workerId: string;
  /** Exactly one of `workspaceKey` / `path` is set — validated on the server, never fixed here. */
  workspaceKey?: string;
  path?: string;
  createIfMissing?: boolean;
  /** Absent = true. Only the opt-out is ever written. */
  stashDirty?: boolean;
  [key: string]: unknown;
}

export interface PipelineSourceDoc {
  kind?: PipelineSourceKind;
  repositoryId?: string;
  workspace?: PipelineWorkspaceDoc;
  [key: string]: unknown;
}

export interface PipelineFinalActionDoc {
  type: PipelineFinalActionType;
  requireApproval?: boolean;
  targetBranch?: { mode?: 'current' | 'new'; prefix?: string; [key: string]: unknown };
  commitMessageTemplate?: string;
  [key: string]: unknown;
}

export interface PipelineHookDoc {
  interpreter: 'bash' | 'node';
  script: string;
  timeoutSec?: number;
  onFail?: 'stop' | 'continue';
  [key: string]: unknown;
}

export interface PipelineDoc {
  stages: PipelineStageDoc[];
  finalAction: PipelineFinalActionDoc;
  source?: PipelineSourceDoc;
  hooks?: { before?: PipelineHookDoc; after?: PipelineHookDoc; [key: string]: unknown };
  triggers?: { humanComment?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}

export type PipelineSourceKind = 'repository' | 'worker_workspace';
export type PipelineFinalActionType = 'commit_and_pr' | 'commit' | 'comment_only' | 'none';
export type HookPosition = 'before' | 'after';

/**
 * The draft the editor starts from: the stored document itself, copied.
 *
 * A JSON round trip rather than a spread — the document is nested, and a shallow copy would let
 * a patch on `source.workspace` reach into the object the screen still shows as "saved".
 */
export function pipelineDraft<T extends PipelineDoc>(spec: T): T {
  return JSON.parse(JSON.stringify(spec)) as T;
}

/**
 * Whether two documents are the same one. `JSON.stringify` and not a deep compare: what the screen
 * is really asking is "would saving change the stored bytes", and that is exactly what the wire
 * carries.
 */
export function sameDocument(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * `{...base, ...patch}` with rule 2: a key whose new value is `undefined` is removed from the
 * result instead of being stored as `undefined` (which `JSON.stringify` would drop anyway, but
 * which makes every in-browser comparison lie about what is in the document).
 */
function patched<T extends Record<string, any>>(base: T | undefined, patch: Record<string, unknown>): T {
  const next: Record<string, unknown> = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as T;
}

/** Drops a key from the document when the object it names has become empty. */
function withOptionalObject<T extends PipelineDoc>(doc: T, key: string, value: Record<string, unknown>): T {
  return patched(doc, { [key]: Object.keys(value).length > 0 ? value : undefined });
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/** Absent `source` means `repository` — what every spec written before the field says. */
export function sourceKindOf(doc: PipelineDoc): PipelineSourceKind {
  return doc.source?.kind === 'worker_workspace' ? 'worker_workspace' : 'repository';
}

/** How the directory is named. `null` when the pipeline does not run in one. */
export function workspaceNamingOf(doc: PipelineDoc): 'key' | 'path' | null {
  const workspace = doc.source?.workspace;
  if (sourceKindOf(doc) !== 'worker_workspace' || !workspace) return null;
  return workspace.path ? 'path' : 'key';
}

/** How many stages ask their agent for a machine-readable verdict. */
export function verdictStageCount(doc: PipelineDoc): number {
  return (doc.stages ?? []).filter((stage) => stage.verdict === true).length;
}

// ---------------------------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------------------------

/** One stage patched in place. Everything else in the document, and in the stage, is untouched. */
export function withStage<T extends PipelineDoc>(doc: T, index: number, patch: Partial<PipelineStageDoc>): T {
  return patched(doc, {
    stages: (doc.stages ?? []).map((stage, at) => (at === index ? patched(stage, patch) : stage)),
  });
}

/** `runtime` is a nested object with one key; merged rather than replaced, like everything else. */
export function withStageRuntime<T extends PipelineDoc>(doc: T, index: number, mode: 'host' | 'docker'): T {
  const stage = (doc.stages ?? [])[index];
  return withStage(doc, index, { runtime: patched(stage?.runtime, { mode }) });
}

/**
 * Replaces the whole stage list and renumbers `order` to 1..N.
 *
 * Renumbering happens **only** here — validation refuses gaps, and the three gestures that can
 * make one (add, remove, move) all come through this function. An ordinary field edit goes through
 * `withStage` and never touches `order`, so a spec whose orders were written by hand keeps them.
 */
export function withStages<T extends PipelineDoc>(doc: T, stages: PipelineStageDoc[]): T {
  return patched(doc, {
    stages: stages.map((stage, index) => (stage.order === index + 1 ? stage : patched(stage, { order: index + 1 }))),
  });
}

export function moveStage<T extends PipelineDoc>(doc: T, index: number, direction: -1 | 1): T {
  const stages = [...(doc.stages ?? [])];
  const target = index + direction;
  if (index < 0 || target < 0 || index >= stages.length || target >= stages.length) return doc;
  [stages[index], stages[target]] = [stages[target], stages[index]];
  return withStages(doc, stages);
}

export function removeStage<T extends PipelineDoc>(doc: T, index: number): T {
  const stages = (doc.stages ?? []).filter((_stage, at) => at !== index);
  // The schema needs at least one stage; refusing here keeps the screen from producing a document
  // the server will reject with a message about `minItems`.
  if (stages.length === 0) return doc;
  return withStages(doc, stages);
}

/**
 * A new stage, appended.
 *
 * `runtime.mode` is `host` and not a choice: docker is the exception (it costs a container and a
 * `worker_workspace` pipeline rejects it outright, because a container cannot see the worker's
 * directory), so a new stage starts where every pipeline can run it and the operator opts in.
 */
export function addStage<T extends PipelineDoc>(doc: T, agentRoleKey: string, role?: string): T {
  const stage: PipelineStageDoc = {
    order: (doc.stages ?? []).length + 1,
    role: (role ?? agentRoleKey ?? 'stage').trim() || 'stage',
    agentRoleKey,
    runtime: { mode: 'host' },
  };
  return withStages(doc, [...(doc.stages ?? []), stage]);
}

// ---------------------------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------------------------

/**
 * The pipeline works against a repository.
 *
 * `repositoryId` absent means "the repository the task came from", which is both the historical
 * behaviour and a different statement from "this one" — hence `undefined` rather than `''`. When
 * the document had no `source` at all and nothing is being pinned, it stays without one: writing
 * `{kind: 'repository'}` would be a new key in a legacy spec that says exactly what its absence
 * already said.
 */
export function withRepositorySource<T extends PipelineDoc>(doc: T, repositoryId: string | undefined): T {
  if (!doc.source && !repositoryId) return doc;
  const source = patched(doc.source, {
    kind: 'repository',
    repositoryId: repositoryId || undefined,
    // A directory belongs to the other kind; leaving it behind would keep a worker pinned in a
    // document that no longer runs there.
    workspace: undefined,
  });
  return patched(doc, { source });
}

/**
 * The pipeline works in a directory on one worker.
 *
 * Two things move with the choice, because the document would otherwise be one the server refuses:
 *
 *   - **delivery.** `canCommit` is the worker's push grant as the caller resolved it
 *     (`lib/workspaceGit.ts`) — the spec cannot grant it, so a `commit` the new directory could not
 *     perform is downgraded to a comment here rather than saved and failed at queue time.
 *     `commit_and_pr` always goes: it belongs to a hosting provider and no worker directory can
 *     perform it.
 *   - **docker stages.** A container has a filesystem of its own and cannot see the worker's
 *     directory, so `worker_workspace` requires `runtime.mode: host` on *every* stage. Left alone,
 *     one docker stage written years ago turns the whole save into «Stage 1 … cannot see a worker
 *     directory», which names a stage the person was not editing. A stage already on `host` is not
 *     touched, so a spec that never had a docker stage comes out unchanged.
 */
export function withWorkspaceSource<T extends PipelineDoc>(
  doc: T,
  workspace: { workerId: string; workspaceKey?: string; path?: string; createIfMissing?: boolean },
  canCommit: boolean,
): T {
  const previous = doc.source?.workspace;
  const next = patched<PipelineWorkspaceDoc>(undefined, {
    workerId: workspace.workerId,
    workspaceKey: workspace.workspaceKey || undefined,
    path: workspace.path || undefined,
    createIfMissing: workspace.createIfMissing ? true : undefined,
    // Carried rather than rebuilt: re-picking the directory must not silently put the dirty-tree
    // policy back to its default.
    stashDirty: previous?.stashDirty,
  });
  const delivery = doc.finalAction?.type;
  const downgrade = delivery === 'commit_and_pr' || (delivery === 'commit' && !canCommit);
  const source = patched(doc.source, {
    kind: 'worker_workspace',
    workspace: next,
    // Only accepted beside a workspace `commit`; it travels with the downgrade.
    repositoryId: downgrade ? undefined : doc.source?.repositoryId,
  });
  const stages = (doc.stages ?? []).map((stage) => (
    stage.runtime?.mode === 'docker' ? patched(stage, { runtime: patched(stage.runtime, { mode: 'host' }) }) : stage
  ));
  return patched(doc, {
    stages,
    source,
    finalAction: downgrade ? patched(doc.finalAction, { type: 'comment_only' }) : doc.finalAction,
  });
}

/** «Убирать чужие изменения в stash». Absent is the default, so only the opt-out is written. */
export function withStashDirty<T extends PipelineDoc>(doc: T, stash: boolean): T {
  const workspace = doc.source?.workspace;
  if (!workspace) return doc;
  return patched(doc, {
    source: patched(doc.source, { workspace: patched(workspace, { stashDirty: stash ? undefined : false }) }),
  });
}

/** The repository a workspace `commit` pushes to. Absent = the remote the checkout already has. */
export function withWorkspaceRepository<T extends PipelineDoc>(doc: T, repositoryId: string | undefined): T {
  return patched(doc, { source: patched(doc.source, { repositoryId: repositoryId || undefined }) });
}

// ---------------------------------------------------------------------------------------------
// What happens after the stages
// ---------------------------------------------------------------------------------------------

export function withFinalAction<T extends PipelineDoc>(doc: T, patch: Partial<PipelineFinalActionDoc>): T {
  return patched(doc, { finalAction: patched(doc.finalAction, patch) });
}

/**
 * Delivery of a `worker_workspace` pipeline.
 *
 * Switching **to** commit brings the three fields that make one meaningful, because a commit with
 * no branch policy and no message template is not a configuration anybody meant. Switching away
 * drops them: they say nothing about a comment, and leaving them would make the document claim a
 * branch policy that nothing reads.
 */
export function withWorkspaceDelivery<T extends PipelineDoc>(
  doc: T,
  type: 'commit' | 'comment_only' | 'none',
): T {
  if (type === doc.finalAction?.type) return doc;
  if (type !== 'commit') {
    return patched(doc, { finalAction: { type } });
  }
  return patched(doc, {
    finalAction: patched(doc.finalAction, {
      type: 'commit',
      requireApproval: true,
      targetBranch: { mode: 'new', prefix: 'agentiz/' },
      commitMessageTemplate: '{{title}}\n\n{{summary}}',
    }),
  });
}

// ---------------------------------------------------------------------------------------------
// Hooks and triggers
// ---------------------------------------------------------------------------------------------

/** One hook written or removed. Removing the last one removes `hooks` itself. */
export function withHook<T extends PipelineDoc>(doc: T, position: HookPosition, hook: PipelineHookDoc | undefined): T {
  const hooks = patched(doc.hooks, { [position]: hook });
  return withOptionalObject(doc, 'hooks', hooks);
}

/**
 * «Запускать после комментария человека».
 *
 * Off removes the key rather than storing `false`: the schema says every trigger is disabled
 * unless explicitly enabled, so `{humanComment: false}` and an absent `triggers` are the same
 * pipeline — and only one of them is what a spec written before the field looks like.
 */
export function withHumanCommentTrigger<T extends PipelineDoc>(doc: T, enabled: boolean): T {
  const triggers = patched(doc.triggers, { humanComment: enabled ? true : undefined });
  return withOptionalObject(doc, 'triggers', triggers);
}
