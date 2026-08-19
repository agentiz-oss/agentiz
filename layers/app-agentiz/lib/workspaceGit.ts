/**
 * Who may push from a directory on a worker's machine.
 *
 * The grant deliberately does not live in the pipeline spec: the directory carries that host's own
 * Git credentials, while a spec can be written by anybody with the panel or an MCP key. So the
 * machine's operator states once which part of the filesystem may reach a remote, and a pipeline can
 * only name a directory inside it.
 *
 * There are two equivalent ways to hold that grant, and both resolve through this module:
 *   - `AgentWorker.gitPushRoots` — path prefixes; a spec may name any directory below one of them
 *     directly by `path`, with no second declaration anywhere.
 *   - `AgentWorker.workspaces[].git.pushEnabled` — the older per-directory grant, which also carries
 *     a non-default remote name. Still honoured, and still the only way to push to something other
 *     than `origin`.
 */

import type { AgentWorkerWorkspace } from '../types/agentiz';

export const DEFAULT_WORKSPACE_REMOTE = 'origin';

/**
 * The message a `workspace_reset` stash carries, spelled from data the server already holds.
 *
 * Kept identical to `_stash_workspace` in `worker/src/agentiz_worker/workspace_git.py`: the sha
 * only exists after a worker has run, but the *name* is knowable in advance, and that is what makes
 * a stash findable (`git stash list`) even in the one case no sha ever comes back — a force-release,
 * which drops the reservation precisely because the worker is unreachable.
 */
export function workspaceStashLabel(proposalId: string, revision?: number | null): string {
  return `agentiz: proposal ${proposalId}` + (revision ? ` revision ${revision}` : '');
}

export interface WorkspaceGitGrant {
  pushEnabled: true;
  remote: string;
}

/** Trailing slashes are noise here: `/srv/projects` and `/srv/projects/` are the same grant. */
export function normalizeGitPushRoot(raw: unknown): string {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  const trimmed = value.replace(/\/+$/, '');
  return trimmed || '/';
}

/** A directory is covered by a root when it *is* that root or lies below it — never by prefix text. */
export function isUnderGitPushRoot(directory: string, root: string): boolean {
  const target = normalizeGitPushRoot(directory);
  const base = normalizeGitPushRoot(root);
  if (!target || !base) return false;
  return target === base || target.startsWith(base === '/' ? '/' : `${base}/`);
}

/** The root that grants this directory, for error messages that have to name what was missing. */
export function gitPushRootFor(directory: string, roots: string[] | null | undefined): string | null {
  return (roots ?? []).find((root) => isUnderGitPushRoot(directory, root)) ?? null;
}

/**
 * The effective grant for a directory: the declared workspace's own `git` block wins, because it is
 * the only place a remote other than `origin` can be named; otherwise a push root covers it.
 */
export function resolveWorkspaceGitGrant(
  directory: string,
  roots: string[] | null | undefined,
  declared?: AgentWorkerWorkspace | null,
): WorkspaceGitGrant | null {
  if (declared?.git?.pushEnabled) {
    return { pushEnabled: true, remote: declared.git.remote?.trim() || DEFAULT_WORKSPACE_REMOTE };
  }
  if (gitPushRootFor(directory, roots)) {
    return { pushEnabled: true, remote: DEFAULT_WORKSPACE_REMOTE };
  }
  return null;
}
