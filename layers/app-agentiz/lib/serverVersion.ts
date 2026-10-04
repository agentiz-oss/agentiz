import { readFileSync } from 'fs';
import path from 'path';
import { AgentActivity } from '../models/AgentActivity';
import { ActivityService } from '../services/ActivityService';

/**
 * "Сервер обновился" — told to the administrators once per build, through the ordinary activity
 * dispatcher (`server.updated`, an installation event: no project, administrators only).
 *
 * The build is identified by `GIT_SHA`, which `container.yml` passes into the image as a build
 * argument — the same value `agentiz.overview` reports as `server.gitSha`. Without it (a local
 * `npm run dev`, an image built by hand, the Dockerfile's own `unknown` default) there is nothing
 * to compare and nothing is announced: a restart under tsx is not a release.
 *
 * The journal **is** the cursor. The previous version is the `data.gitSha` of the latest
 * `server.updated` row, so a restart of the same image says nothing, a new image speaks once, and
 * a rollback speaks too — it is a different build running, which is what an administrator wants to
 * know. No second store means nothing that can disagree with the feed. The very first start with
 * this module has no row to compare with and announces itself, with the previous version unknown.
 *
 * What it does not do: deduplicate between replicas. Two processes of one new image starting
 * together would both find the old row and both announce; a deployment with replicas would need a
 * unique key on the row, which a single-container deployment does not.
 */

export const SERVER_UPDATED_ACTIVITY = 'server.updated';

/**
 * Why the announcement waits instead of running in `mount()`. Delivery layers register their
 * notifiers while *they* mount — the phone's after this layer's — and a dispatch reaches only the
 * notifiers registered at that moment. A minute also means the message says "this build came up
 * and stayed up": an image that crash-loops on start never announces itself.
 */
export const SERVER_VERSION_ANNOUNCE_DELAY_MS = 60_000;

export interface ServerVersion {
  gitSha: string;
  buildTime: string | null;
  packageVersion: string | null;
}

function packageVersion(): string | null {
  try {
    const raw = JSON.parse(readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'));
    return typeof raw.version === 'string' ? raw.version : null;
  } catch {
    return null;
  }
}

/** The running build, or `null` when this process does not know which build it is. */
export function currentServerVersion(env: NodeJS.ProcessEnv = process.env): ServerVersion | null {
  const gitSha = env.GIT_SHA?.trim();
  if (!gitSha || gitSha === 'unknown') return null;
  const buildTime = env.BUILD_TIME?.trim();
  return {
    gitSha,
    buildTime: buildTime && buildTime !== 'unknown' ? buildTime : null,
    packageVersion: packageVersion(),
  };
}

/** Eight characters, like the version line the panel itself prints (`config/adminizer.ts`). */
function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

export type ServerVersionAnnouncement =
  | { outcome: 'unknown' }
  | { outcome: 'unchanged'; gitSha: string }
  | { outcome: 'announced'; gitSha: string; previousGitSha: string | null }
  | { outcome: 'failed'; gitSha: string };

export async function announceServerVersion(
  version: ServerVersion | null = currentServerVersion(),
): Promise<ServerVersionAnnouncement> {
  if (!version) return { outcome: 'unknown' };

  const last = await AgentActivity.findOne({
    where: { type: SERVER_UPDATED_ACTIVITY, projectId: null },
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
  });
  const previousGitSha = typeof last?.data?.gitSha === 'string' ? last.data.gitSha : null;
  if (previousGitSha === version.gitSha) return { outcome: 'unchanged', gitSha: version.gitSha };

  // The text says only that the server was updated and to what. The previous version and the build
  // time stay in `data` for whoever needs them, out of the words a person reads.
  const activity = await ActivityService.recordInstallation({
    type: SERVER_UPDATED_ACTIVITY,
    title: 'Сервер обновился',
    body: `Новая версия: ${shortSha(version.gitSha)}`,
    data: {
      gitSha: version.gitSha,
      previousGitSha,
      buildTime: version.buildTime,
      packageVersion: version.packageVersion,
    },
  });
  return activity
    ? { outcome: 'announced', gitSha: version.gitSha, previousGitSha }
    : { outcome: 'failed', gitSha: version.gitSha };
}

/** Starts the delayed announcement; the returned function cancels it (for `unmount()`). */
export function scheduleServerVersionAnnouncement(delayMs = SERVER_VERSION_ANNOUNCE_DELAY_MS): () => void {
  const timer = setTimeout(() => {
    void announceServerVersion()
      .then((result) => {
        if (result.outcome === 'announced') {
          console.log(`[AppAgentiz] server version ${shortSha(result.gitSha)} announced to administrators`
            + (result.previousGitSha ? ` (was ${shortSha(result.previousGitSha)})` : ' (no previous version on record)'));
        } else if (result.outcome === 'failed') {
          console.warn(`[AppAgentiz] server version ${shortSha(result.gitSha)} was not announced — see the activity warning above`);
        }
      })
      .catch((error) => {
        console.warn('[AppAgentiz] server version check failed:', error instanceof Error ? error.message : error);
      });
  }, delayMs);
  // A pending announcement must not keep a process alive that is otherwise shutting down.
  timer.unref?.();
  return () => clearTimeout(timer);
}
