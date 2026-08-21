/**
 * Which project a prepared directory on a worker belongs to.
 *
 * A pipeline spec is a project's own entity (`PipelineSpec.projectId`, and it never moves to
 * another project), but until this existed the *directory* it ran in was not: two projects could
 * point their specs at the same worker path, and the first one to open a workspace proposal blocked
 * every run of the other with "Workspace ... is reserved by proposal ..." — a reservation is keyed
 * by worker+path and knows nothing about projects. That is not a scheduling accident to be waited
 * out: the second project's agent would have worked in a checkout belonging to the first.
 *
 * So the worker's operator states the owner once, on the declaration (`setWorkspaces`), and a spec
 * of any other project is refused — at save time, where the mistake is made, and again at queue
 * time, because a grant can be narrowed long after a spec was stored. A declaration with no
 * `projectId` stays shared, exactly as every workspace behaved before this field existed.
 */

import type { AgentWorkerWorkspace } from '../types/agentiz';

export interface WorkspaceOwnerRef {
  /** The declared directory, when the spec named it by `workspaceKey`. */
  declared?: AgentWorkerWorkspace | null;
  /** The absolute path, which a spec can also name directly, bypassing the declaration. */
  path?: string | null;
}

/** The declaration that owns `path` on this worker, if the operator bound one to a project. */
export function declarationForPath(
  workspaces: AgentWorkerWorkspace[] | null | undefined,
  path: string | null | undefined,
): AgentWorkerWorkspace | null {
  const target = String(path ?? '').trim().replace(/\/+$/, '');
  if (!target) return null;
  return (workspaces ?? []).find(
    (item) => String(item.path ?? '').trim().replace(/\/+$/, '') === target,
  ) ?? null;
}

/**
 * The project owning the directory a spec points at, or null when it is unbound (shared).
 *
 * Both naming forms resolve here: a `workspaceKey` carries its declaration, and a bare `path` is
 * matched back to a declaration of the same directory — otherwise renaming `workspaceKey` to the
 * path it resolves to would be a way around the binding, the same loophole the reservation lookup
 * in `AgentPipelineService.buildSnapshot` closes by matching on the path as well as the key.
 */
export function workspaceOwnerProjectId(
  workspaces: AgentWorkerWorkspace[] | null | undefined,
  ref: WorkspaceOwnerRef,
): string | null {
  const declared = ref.declared ?? declarationForPath(workspaces, ref.path);
  const owner = String(declared?.projectId ?? '').trim();
  return owner || null;
}

/** The refusal text, spelled once: it is shown by the spec editor, MCP and the queue alike. */
export function workspaceOwnershipError(
  workerName: string,
  named: string,
  ownerProjectId: string,
  specProjectId: string,
): string {
  return `Directory ${named} on worker "${workerName}" belongs to project ${ownerProjectId},`
    + ` and this pipeline spec belongs to project ${specProjectId}.`
    + ' A prepared directory is one project\'s workspace: point the spec at a directory of its own'
    + ' project, or clear that workspace\'s projectId to share it deliberately.';
}

/** Throws when `specProjectId` may not use this directory. Shared (unbound) directories pass. */
export function assertWorkspaceOwnership(options: {
  workerName: string;
  workspaces: AgentWorkerWorkspace[] | null | undefined;
  specProjectId: string;
  named: string;
  ref: WorkspaceOwnerRef;
}): void {
  const owner = workspaceOwnerProjectId(options.workspaces, options.ref);
  if (!owner || owner === options.specProjectId) return;
  throw new Error(workspaceOwnershipError(options.workerName, options.named, owner, options.specProjectId));
}
