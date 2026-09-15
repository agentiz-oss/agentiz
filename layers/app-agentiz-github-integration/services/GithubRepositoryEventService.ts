import { syncRepositoryWebhook } from '../../app-agentiz/lib/webhooks/repositoryWebhook';
import { AgentGitConnection } from '../../app-agentiz/models/AgentGitConnection';
import { AgentRepository } from '../../app-agentiz/models/AgentRepository';
import {
  forgetBranch,
  publishRepositoryCiRun,
  publishRepositoryPush,
  seedWatchCursor,
  watchCursorOf,
  watchedRepositories,
} from '../../app-agentiz/lib/workflow/repositoryEvents';
import { GithubOAuthService } from './GithubOAuthService';
import type { GithubApiClient, GithubComparison } from '../lib/GithubApiClient';

/**
 * The safety net half of watching a repository (`.ai-notes/repository-events-workflow-plan.md` §3):
 * every 15 minutes, ask GitHub what changed since the stored cursor.
 *
 * It is **not** turned off for repositories that have a webhook, and that is the design rather than
 * an oversight: GitHub does not retry a delivery it could not make, and our server is unreachable
 * for a minute on every deploy. What makes the two sources one instead of two is the shared cursor
 * — a push a hook already reported leaves the branch head equal to the stored one, and this pass
 * says nothing about it.
 *
 * Everything about what an event *is* — the payload, the fan-out over projects, the attribution to
 * one of our own runs, the feed row — belongs to the core publisher. This file only knows how to
 * ask GitHub.
 */

/** How many CI runs one pass reports at most, so a repository that built 500 times does not flood. */
const MAX_CI_RUNS_PER_PASS = 20;

export interface RepositoryPollResult {
  repositoryId: string;
  pathWithNamespace: string;
  /** `true` when this pass only filled the cursor — the first look at a repository emits nothing. */
  seeded: boolean;
  pushes: number;
  ciRuns: number;
  skipped: 'idle' | null;
  errors: string[];
}

export class GithubRepositoryEventService {
  /**
   * One pass over every repository connected to a project through an active link.
   *
   * Not over the whole mirror: `AgentRepository` holds everything the account can reach, and asking
   * GitHub about all of it would spend the hourly budget on repositories nobody uses.
   */
  static async pollAll(): Promise<RepositoryPollResult[]> {
    const repositories = await watchedRepositories('github');
    const results: RepositoryPollResult[] = [];
    for (const repository of repositories) {
      try {
        // Reconcile the hook on the way past. The lifecycle hook on `AgentProjectRepository` only
        // fires when somebody *writes* a link, so without this a repository linked long ago would
        // never notice a hook that fell off — or, more quietly, one installed before a fact was
        // added to `HOOK_EVENTS` and therefore still delivering the old set. Idempotent and free
        // in the common path: no API call once the URL and the event set already match.
        await syncRepositoryWebhook(repository.id).catch((): undefined => undefined);
        await repository.reload();
        results.push(await this.poll(repository));
      } catch (error) {
        results.push({
          repositoryId: repository.id,
          pathWithNamespace: repository.pathWithNamespace,
          seeded: false,
          pushes: 0,
          ciRuns: 0,
          skipped: null,
          errors: [error instanceof Error ? error.message : String(error)],
        });
      }
    }
    return results;
  }

  static async poll(repository: AgentRepository): Promise<RepositoryPollResult> {
    const result: RepositoryPollResult = {
      repositoryId: repository.id,
      pathWithNamespace: repository.pathWithNamespace,
      seeded: false,
      pushes: 0,
      ciRuns: 0,
      skipped: null,
      errors: [],
    };

    const cursor = watchCursorOf(repository);
    const seeding = !cursor.checkedAt;

    // The cheap filter, and the reason a hundred connected repositories cost almost nothing on a
    // quiet pass: `lastActivityAt` mirrors GitHub's own `pushed_at` and is refreshed by the
    // repository sync that runs earlier in the same cron tick. Not applied while seeding — a
    // repository nobody has pushed to in a year still needs its cursor filled once.
    if (!seeding && repository.lastActivityAt && cursor.checkedAt) {
      if (repository.lastActivityAt.toISOString() <= cursor.checkedAt) {
        result.skipped = 'idle';
        return result;
      }
    }

    const connection = await AgentGitConnection.findByPk(repository.connectionId);
    if (!connection || connection.status !== 'active') {
      result.errors.push(`connection ${repository.connectionId} is not active`);
      return result;
    }
    const client = await GithubOAuthService.apiClientFor(connection);

    if (seeding) {
      // One write at the end, not a cursor built up branch by branch: a pass that died halfway
      // would otherwise leave a partial cursor, and the next pass would read every branch missing
      // from it as brand new and raise the flood this whole path exists to prevent.
      const [branches, runs] = await Promise.all([
        client.listBranches(repository.owner, repository.repo),
        client.listWorkflowRuns(repository.owner, repository.repo),
      ]);
      await seedWatchCursor(repository, {
        branchHeads: Object.fromEntries(branches.map((branch) => [branch.name, branch.commit.sha])),
        lastCiRunId: runs.reduce((max, run) => Math.max(max, run.id), 0) || null,
      });
      result.seeded = true;
      return result;
    }

    await this.pollBranches(repository, client, result);
    await this.pollCiRuns(repository, client, result);
    return result;
  }

  /**
   * Branch heads against the cursor.
   *
   * Three shapes come out of this comparison and each has its own reading:
   * a branch the cursor does not know is **new** (`beforeSha: null`, and its commits are the ones
   * it does not share with the default branch); a branch whose head moved is an ordinary push, and
   * whether it was forced is `compare`'s own `status: 'diverged'` rather than anything we compute;
   * a branch the cursor knows and GitHub no longer lists was **deleted** — no event for it, the
   * head is simply dropped, so that a branch recreated later reads as new rather than as a
   * force-push from a head that does not exist any more.
   */
  private static async pollBranches(
    repository: AgentRepository,
    client: GithubApiClient,
    result: RepositoryPollResult,
  ): Promise<void> {
    const branches = await client.listBranches(repository.owner, repository.repo);
    const cursor = watchCursorOf(repository);
    const seen = new Set<string>();

    for (const branch of branches) {
      seen.add(branch.name);
      const previous = cursor.branchHeads[branch.name] ?? null;
      if (previous === branch.commit.sha) continue;

      let comparison: GithubComparison | null = null;
      const base = previous ?? repository.defaultBranch ?? null;
      if (base && base !== branch.commit.sha) {
        try {
          comparison = await client.compareCommits(repository.owner, repository.repo, base, branch.commit.sha);
        } catch (error) {
          // A base GitHub cannot resolve any more (the old head was garbage-collected after a
          // force-push) must not lose the event: report the push with no commit list rather than
          // nothing at all, and let the cursor move on.
          result.errors.push(`${branch.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      await publishRepositoryPush(repository, {
        branch: branch.name,
        beforeSha: previous,
        afterSha: branch.commit.sha,
        forced: comparison?.status === 'diverged',
        commits: (comparison?.commits ?? []).map((commit) => ({
          sha: commit.sha,
          message: commit.commit.message,
          author: commit.author?.login ?? commit.commit.author?.name ?? '',
          url: commit.html_url,
        })),
        compareUrl: comparison?.html_url ?? null,
      });
      result.pushes += 1;
    }

    for (const branch of Object.keys(cursor.branchHeads)) {
      if (!seen.has(branch)) await forgetBranch(repository, branch);
    }
  }

  /** Finished Actions runs newer than the cursor, oldest first so the cursor only ever moves up. */
  private static async pollCiRuns(
    repository: AgentRepository,
    client: GithubApiClient,
    result: RepositoryPollResult,
  ): Promise<void> {
    const runs = await client.listWorkflowRuns(repository.owner, repository.repo);
    if (runs.length === 0) return;
    const cursor = watchCursorOf(repository);

    const fresh = runs
      .filter((run) => run.id > (cursor.lastCiRunId ?? 0))
      .sort((a, b) => a.id - b.id)
      .slice(-MAX_CI_RUNS_PER_PASS);

    for (const run of fresh) {
      await publishRepositoryCiRun(repository, {
        branch: run.head_branch ?? '',
        headSha: run.head_sha,
        workflowName: run.name ?? '',
        conclusion: run.conclusion ?? 'neutral',
        url: run.html_url,
        externalRunId: String(run.id),
      });
      result.ciRuns += 1;
    }
  }
}
