/**
 * The one path a repository fact takes into a workflow — `.ai-notes/repository-events-workflow-plan.md` §3.
 *
 * Two sources observe the same two facts: the 15-minute poll in the provider layer (the safety net)
 * and a webhook delivery (the fast path). They meet here, and it is this function — not either
 * source — that owns the four things that must happen exactly once per fact:
 *
 * 1. **fan-out over projects.** The fact belongs to a repository; every node downstream filters by
 *    project. One repository linked to two projects therefore raises two events, one per active
 *    `AgentProjectRepository`, and the platform is still read once.
 * 2. **attribution.** Whether this push is one of our own runs' (§6) — the answer is the same for
 *    every project copy, so it is resolved once, before the fan-out.
 * 3. **the feed row.** Every event lands in `AgentActivity` regardless of any notification policy;
 *    that journal is the only way to debug "запушили, а флоу не стартовал".
 * 4. **the cursor.** `AgentRepository.watchCursor` moves here and nowhere else, which is what makes
 *    two sources one: what a delivered hook already advanced, the next poll reads as unchanged and
 *    stays silent about.
 *
 * It lives in the core rather than in the GitHub layer even though GitHub is the only source today:
 * everything above is provider-neutral, and a GitLab layer should contribute a reader, not a second
 * copy of this.
 */

import { Op } from 'sequelize';
import { AgentProjectRepository } from '../../models/AgentProjectRepository';
import { AgentRepository } from '../../models/AgentRepository';
import { AgentRun } from '../../models/AgentRun';
import { ActivityService } from '../../services/ActivityService';
import type { RepositoryWatchCursor } from '../../types/agentiz';
import {
  AGENTIZ_REPOSITORY_CI_RUN,
  AGENTIZ_REPOSITORY_PACKAGE,
  AGENTIZ_REPOSITORY_PUSHED,
  emitAgentizEvent,
  type AgentizRepositoryCiRunPayload,
  type AgentizRepositoryPackagePayload,
  type AgentizRepositoryPushedPayload,
} from './events';

/** What a source observed about a push, before it knows anything about projects or our own runs. */
export interface RepositoryPushObservation {
  branch: string;
  /** `null` = the branch is new. */
  beforeSha: string | null;
  afterSha: string;
  forced: boolean;
  commits: Array<{ sha: string; message: string; author: string; url: string }>;
  compareUrl: string | null;
}

/** What a source observed about a finished CI run. */
export interface RepositoryCiRunObservation {
  branch: string;
  headSha: string;
  workflowName: string;
  conclusion: string;
  url: string;
  /** The platform's own run id. Numeric where the platform numbers them — that is what orders them. */
  externalRunId: string;
}

/** What a source observed about a published package version. */
export interface RepositoryPackageObservation {
  packageName: string;
  packageType: string;
  namespace: string;
  action: string;
  version: string;
  tag: string;
  digest: string;
  packageUrl: string;
  htmlUrl: string;
}

/** How many commits of one push travel in the payload; the rest are counted, not carried. */
const MAX_COMMITS_IN_PAYLOAD = 20;

/** Result of one publication, for the caller's log and for tests. */
export interface RepositoryEventPublication {
  /** How many project copies were emitted. Zero = the repository is linked to no active project. */
  emitted: number;
  ownRunId: string | null;
  ownTaskId: string | null;
}

/**
 * Which run, if any, produced work on this branch of this project (§6).
 *
 * Matched on the branch, not on the sha, and deliberately so: a person who adds one more commit to
 * the agent's branch by hand is still working inside a round that is already running, and waking a
 * second one on top of it is the loop this guard exists to prevent. The sha travels in the payload
 * as a fact, so a graph that wants the narrower reading can compare `afterSha` to it itself.
 *
 * Not time-bounded: a run's branch lives until it is merged, which can be days.
 */
async function attributeToRun(projectId: string, branch: string): Promise<AgentRun | null> {
  if (!branch) return null;
  return AgentRun.findOne({
    where: { projectId, branch },
    order: [['createdAt', 'DESC']],
  });
}

/** Active links of this repository — one event per project the repository actually reaches. */
async function activeLinks(repositoryId: string): Promise<AgentProjectRepository[]> {
  return AgentProjectRepository.findAll({
    where: { repositoryId, isActive: true },
    order: [['createdAt', 'ASC']],
  });
}

/**
 * Cursor writes go through here so that a caller can never advance one half and forget the other.
 *
 * Read-modify-write on the JSON column rather than a partial update: the two sources can land on
 * the same repository at the same moment, and `AgentRepository` is not row-locked here — losing a
 * branch head to a concurrent CI-run write would replay that branch on the next poll, which is a
 * duplicate event rather than a missed one. That is the safe direction of the trade.
 */
async function advanceCursor(
  repository: AgentRepository,
  mutate: (cursor: RepositoryWatchCursor) => void,
): Promise<void> {
  const cursor: RepositoryWatchCursor = { ...(repository.watchCursor ?? {}) };
  cursor.branchHeads = { ...(cursor.branchHeads ?? {}) };
  mutate(cursor);
  cursor.checkedAt = new Date().toISOString();
  await repository.update({ watchCursor: cursor });
}

/** The cursor a source reads to decide what is new. Never null, so callers need no defaulting. */
export function watchCursorOf(repository: AgentRepository): Required<RepositoryWatchCursor> {
  const cursor = repository.watchCursor ?? {};
  return {
    branchHeads: { ...(cursor.branchHeads ?? {}) },
    lastCiRunId: cursor.lastCiRunId ?? null,
    checkedAt: cursor.checkedAt ?? '',
  };
}

/**
 * The first look at a repository: remember where it stands and report **nothing**.
 *
 * Its own function rather than "publish with an empty commit list", because the difference is the
 * whole point — seeding must not emit an event, must not write a feed row and must not wake a
 * graph. Connecting a repository would otherwise raise its entire branch history and every CI run
 * it has ever finished, all at once.
 *
 * Writes the cursor whole, so a source that hit an error partway through does not leave half a
 * cursor behind, which the next pass would read as "everything else is brand new".
 */
export async function seedWatchCursor(
  repository: AgentRepository,
  seed: { branchHeads: Record<string, string>; lastCiRunId: number | null },
): Promise<void> {
  await repository.update({
    watchCursor: {
      branchHeads: { ...seed.branchHeads },
      lastCiRunId: seed.lastCiRunId,
      checkedAt: new Date().toISOString(),
    },
  });
}

/**
 * A branch disappeared upstream.
 *
 * No event: "ветку удалили" is not one of the two facts this feature watches, and inventing a third
 * one here would reach nodes that cannot express it. The head is dropped from the cursor so that a
 * branch recreated later reads as new (`beforeSha: null`) rather than as a force-push from a head
 * that no longer exists.
 */
export async function forgetBranch(repository: AgentRepository, branch: string): Promise<void> {
  if (!repository.watchCursor?.branchHeads?.[branch]) return;
  await advanceCursor(repository, (cursor) => {
    delete cursor.branchHeads![branch];
  });
}

/** `agentiz.repository.pushed`, fanned out, journalled and cursor-advanced. */
export async function publishRepositoryPush(
  repository: AgentRepository,
  observation: RepositoryPushObservation,
): Promise<RepositoryEventPublication> {
  const links = await activeLinks(repository.id);
  const commits = observation.commits.slice(0, MAX_COMMITS_IN_PAYLOAD);
  let ownRunId: string | null = null;
  let ownTaskId: string | null = null;

  for (const link of links) {
    const run = await attributeToRun(link.projectId, observation.branch);
    if (run) {
      ownRunId = run.id;
      ownTaskId = run.taskId;
    }
    const payload: AgentizRepositoryPushedPayload = {
      projectId: link.projectId,
      repositoryId: repository.id,
      projectRepositoryId: link.id,
      provider: repository.provider,
      pathWithNamespace: repository.pathWithNamespace,
      webUrl: repository.webUrl ?? null,
      branch: observation.branch,
      beforeSha: observation.beforeSha,
      afterSha: observation.afterSha,
      forced: observation.forced,
      commits,
      compareUrl: observation.compareUrl,
      ownRunId: run?.id ?? null,
      ownTaskId: run?.taskId ?? null,
      // The address every node downstream reads. Absent for a push nobody's run made — which is
      // the normal case `agentiz.task.create` exists for.
      ...(run ? { taskId: run.taskId } : {}),
    };
    emitAgentizEvent(AGENTIZ_REPOSITORY_PUSHED, payload);
    await ActivityService.record({
      type: 'repository.pushed',
      projectId: link.projectId,
      taskId: run?.taskId ?? null,
      runId: run?.id ?? null,
      title: `${repository.pathWithNamespace}: ${commits.length || observation.commits.length} коммит(ов) в ${observation.branch}`,
      body: commits.map((commit) => `${commit.sha.slice(0, 8)} ${commit.message.split('\n')[0]}`).join('\n'),
      data: { repositoryId: repository.id, branch: observation.branch, afterSha: observation.afterSha, compareUrl: observation.compareUrl },
    });
  }

  await advanceCursor(repository, (cursor) => {
    cursor.branchHeads![observation.branch] = observation.afterSha;
  });

  return { emitted: links.length, ownRunId, ownTaskId };
}

/** `agentiz.repository.ciRun`, same three responsibilities plus the run-id half of the cursor. */
export async function publishRepositoryCiRun(
  repository: AgentRepository,
  observation: RepositoryCiRunObservation,
): Promise<RepositoryEventPublication> {
  const links = await activeLinks(repository.id);
  let ownRunId: string | null = null;
  let ownTaskId: string | null = null;

  for (const link of links) {
    const run = await attributeToRun(link.projectId, observation.branch);
    if (run) {
      ownRunId = run.id;
      ownTaskId = run.taskId;
    }
    const payload: AgentizRepositoryCiRunPayload = {
      projectId: link.projectId,
      repositoryId: repository.id,
      projectRepositoryId: link.id,
      provider: repository.provider,
      pathWithNamespace: repository.pathWithNamespace,
      webUrl: repository.webUrl ?? null,
      branch: observation.branch,
      headSha: observation.headSha,
      workflowName: observation.workflowName,
      conclusion: observation.conclusion,
      url: observation.url,
      externalRunId: observation.externalRunId,
      ownRunId: run?.id ?? null,
      ownTaskId: run?.taskId ?? null,
      // For CI this is not a nuisance to filter out but the point: it is what lets
      // `agentiz.task.comment` put a failed build into the thread of the task that caused it.
      ...(run ? { taskId: run.taskId } : {}),
    };
    emitAgentizEvent(AGENTIZ_REPOSITORY_CI_RUN, payload);
    await ActivityService.record({
      type: 'repository.ci_run',
      projectId: link.projectId,
      taskId: run?.taskId ?? null,
      runId: run?.id ?? null,
      title: `${repository.pathWithNamespace}: ${observation.workflowName} — ${observation.conclusion} (${observation.branch})`,
      body: observation.url,
      data: {
        repositoryId: repository.id,
        branch: observation.branch,
        conclusion: observation.conclusion,
        url: observation.url,
        externalRunId: observation.externalRunId,
      },
    });
  }

  const numericId = Number(observation.externalRunId);
  await advanceCursor(repository, (cursor) => {
    if (!Number.isFinite(numericId)) return;
    cursor.lastCiRunId = Math.max(cursor.lastCiRunId ?? 0, numericId);
  });

  return { emitted: links.length, ownRunId, ownTaskId };
}

/**
 * `agentiz.repository.packagePublished`, fanned out and journalled.
 *
 * Two of this module's four responsibilities on purpose, and the two that are missing are missing
 * for the same reason: this fact has **one** observer.
 *
 * - no cursor. `watchCursor` exists to keep a hook and a poll from reporting one fact twice, and
 *   nothing polls a registry; the delivery journal's unique `(endpointId, dedupeKey)` is what makes
 *   a re-delivery idempotent instead. Advancing a cursor here would be bookkeeping nobody reads.
 * - no attribution. There is no branch on an image, so tying it to `AgentRun.branch` is not merely
 *   unimplemented but unanswerable; the payload carries no `ownRunId`/`taskId`, and a graph that
 *   creates a task from this event uses `agentiz.task.create` like any other.
 */
export async function publishRepositoryPackage(
  repository: AgentRepository,
  observation: RepositoryPackageObservation,
): Promise<RepositoryEventPublication> {
  const links = await activeLinks(repository.id);
  const named = observation.tag
    ? `${observation.packageName}:${observation.tag}`
    : `${observation.packageName} ${observation.version}`.trim();

  for (const link of links) {
    const payload: AgentizRepositoryPackagePayload = {
      projectId: link.projectId,
      repositoryId: repository.id,
      projectRepositoryId: link.id,
      provider: repository.provider,
      pathWithNamespace: repository.pathWithNamespace,
      webUrl: repository.webUrl ?? null,
      packageName: observation.packageName,
      packageType: observation.packageType,
      namespace: observation.namespace,
      action: observation.action,
      version: observation.version,
      tag: observation.tag,
      digest: observation.digest,
      packageUrl: observation.packageUrl,
      htmlUrl: observation.htmlUrl,
    };
    emitAgentizEvent(AGENTIZ_REPOSITORY_PACKAGE, payload);
    await ActivityService.record({
      type: 'repository.package',
      projectId: link.projectId,
      taskId: null,
      runId: null,
      title: `${repository.pathWithNamespace}: опубликован пакет ${named}`,
      body: observation.htmlUrl || observation.packageUrl,
      data: {
        repositoryId: repository.id,
        packageName: observation.packageName,
        packageType: observation.packageType,
        tag: observation.tag,
        digest: observation.digest,
        packageUrl: observation.packageUrl,
        htmlUrl: observation.htmlUrl,
      },
    });
  }

  return { emitted: links.length, ownRunId: null, ownTaskId: null };
}

/**
 * Repositories worth asking the platform about: linked to at least one project, through an active
 * link, on this provider.
 *
 * Not "every mirrored repository" — the mirror holds everything the account can reach, and polling
 * that would spend the hourly API budget on repositories nobody connected to anything.
 */
export async function watchedRepositories(provider: string): Promise<AgentRepository[]> {
  const links = await AgentProjectRepository.findAll({
    where: { provider: provider as never, isActive: true },
    attributes: ['repositoryId'],
  });
  const ids = [...new Set(links.map((link) => link.repositoryId))];
  if (ids.length === 0) return [];
  return AgentRepository.findAll({ where: { id: { [Op.in]: ids } } });
}
