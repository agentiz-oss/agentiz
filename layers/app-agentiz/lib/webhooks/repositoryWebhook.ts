/**
 * Keeps a repository's webhook in step with whether any project still uses that repository.
 *
 * The hook belongs to the **repository**, not to the link: two projects on one repository share one
 * delivery, and the fan-out over projects happens afterwards in `publishRepositoryEvent`. So the
 * question this module answers is a single boolean — "does at least one active
 * `AgentProjectRepository` point at this repository" — and it is asked from the model hooks of that
 * table, not from the panel route, because there are four ways a link is written (panel, MCP,
 * Adminizer CRUD, a provider layer's own sync) and only a model hook covers all of them.
 *
 * Everything about *how* a hook is installed is the provider layer's (`GitConnectionAuthority
 * .syncWebhook`). A provider that does not implement it, or a layer that is not mounted, means the
 * repository is watched by the poll alone — which is a supported configuration, not a failure, so
 * nothing here throws or writes an error anywhere.
 */

import { AgentProjectRepository } from '../../models/AgentProjectRepository';
import { AgentRepository } from '../../models/AgentRepository';
import { getGitConnectionAuthority } from '../git';
import { trackDetachedWork } from '../detachedWork';

/**
 * One reconciliation at a time per repository.
 *
 * Linking two projects to one repository in the same breath fires this twice, and two concurrent
 * passes over one repository do real damage rather than duplicate work: each reads the platform's
 * hook list, each deletes what it thinks is a stale hook of ours, and each writes its own secret
 * over the other's — leaving a hook whose secret nobody stored, so every delivery fails its
 * signature check. Chaining is enough because the reconciliation is idempotent: the second pass
 * finds the first one's work done and costs nothing.
 *
 * Parked on a global symbol like every other mutable registry here — under tsx this module can be
 * instantiated twice and two maps would be no serialization at all.
 */
const INFLIGHT_KEY = Symbol.for('agentiz.repositoryWebhookSync');

function inflight(): Map<string, Promise<void>> {
  const holder = globalThis as unknown as Record<symbol, Map<string, Promise<void>>>;
  if (!holder[INFLIGHT_KEY]) holder[INFLIGHT_KEY] = new Map();
  return holder[INFLIGHT_KEY];
}

/**
 * Reconcile one repository's hook with the links that exist right now.
 *
 * Never awaited by its model-hook callers: a platform that is slow or down must not be able to fail
 * the write that linked a repository to a project.
 */
export async function syncRepositoryWebhook(repositoryId: string): Promise<void> {
  const queue = inflight();
  const previous = queue.get(repositoryId) ?? Promise.resolve();
  const next = previous
    .catch((): undefined => undefined)
    .then(() => reconcile(repositoryId));
  queue.set(repositoryId, next);
  try {
    await next;
  } finally {
    if (queue.get(repositoryId) === next) queue.delete(repositoryId);
  }
}

async function reconcile(repositoryId: string): Promise<void> {
  // Re-read rather than take an instance from the caller: by the time the chain reaches this
  // repository, whatever the previous pass wrote to `webhook` is what is true.
  const repository = await AgentRepository.findByPk(repositoryId);
  if (!repository) return;
  const authority = getGitConnectionAuthority(repository.provider);
  if (!authority?.syncWebhook) return;

  const active = await AgentProjectRepository.count({ where: { repositoryId, isActive: true } });
  await authority.syncWebhook(repository, active > 0);
}

/**
 * Fire-and-forget wrapper for the model hooks; a failure is logged and never propagated.
 *
 * Tracked as detached work (`lib/detachedWork.ts`) because this is the classic shape of work that
 * outlives its caller: the link row's `afterCommit` returns long before the platform answers, and
 * without a barrier the only way to observe the result is to guess how long it takes.
 */
export function scheduleRepositoryWebhookSync(repositoryId: string): void {
  void trackDetachedWork(syncRepositoryWebhook(repositoryId)).catch((error) => {
    console.warn(
      `[app-agentiz] webhook sync for repository ${repositoryId} failed:`,
      error instanceof Error ? error.message : error,
    );
  });
}
