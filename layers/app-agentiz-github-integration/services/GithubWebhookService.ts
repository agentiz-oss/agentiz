import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { AgentGitConnection } from '../../app-agentiz/models/AgentGitConnection';
import { AgentRepository } from '../../app-agentiz/models/AgentRepository';
import { getWebhookHost } from '../../app-agentiz/lib/webhooks';
import type { WebhookDeliveryContext, WebhookMapper, WebhookMapResult } from '../../app-agentiz/lib/webhooks';
import {
  forgetBranch,
  publishRepositoryCiRun,
  publishRepositoryPackage,
  publishRepositoryPush,
} from '../../app-agentiz/lib/workflow/repositoryEvents';
import type { RepositoryWebhookState } from '../../app-agentiz/types/agentiz';
import { GithubOAuthService } from './GithubOAuthService';

/**
 * The fast half of watching a repository: a webhook GitHub delivers to us, installed by us
 * (`.ai-notes/repository-events-workflow-plan.md` §3b).
 *
 * Three properties hold this together and are worth stating before the code:
 *
 * - **one hook per `AgentRepository`, not per project link.** Two projects on one repository share
 *   one delivery; the fan-out over projects is `publishRepositoryEvent`'s job, and duplicating the
 *   hook would duplicate the event before anything could deduplicate it.
 * - **the secret belongs to the repository.** We issued it *to* GitHub, so the signature of an
 *   incoming delivery is checked against `AgentRepository.webhook.secret` — which is why the
 *   mapper below declares `auth: 'mapper'` instead of letting the receiving layer compare a token
 *   against the endpoint's own.
 * - **it degrades, it does not fail.** No public URL, no receiving layer, a connection whose scope
 *   an organisation trimmed — each of those means "no hook", the reason is written to
 *   `webhook.lastError` where a person can read it, and the repository keeps being watched by the
 *   15-minute poll. Nothing here throws at a caller.
 *
 * No new OAuth scope is needed: `repo`, which every connection already carries, covers installing
 * a hook and reading its delivery log.
 */

/**
 * What we ask GitHub to send — exactly the facts the core has events for.
 *
 * `package` is GitHub's current name for what older documentation calls `registry_package`; only
 * the current one is subscribed to, because an unknown event name makes hook **creation** fail
 * with 422 and would cost us `push` and `workflow_run` as well. The mapper still answers to both
 * spellings, since which one a delivery carries in `X-GitHub-Event` is GitHub's business.
 *
 * A container package only reaches a *repository* hook when it is linked to that repository —
 * publishing from its workflow does that, as does the `org.opencontainers.image.source` label.
 * An unlinked package is an org-level event and no repository hook of ours ever sees it.
 */
const HOOK_EVENTS = ['push', 'workflow_run', 'package'];

const MAPPER_KIND = 'github-repository';

/** Idempotency key of the endpoint row, so re-linking a repository reuses the same URL. */
function ownerKeyOf(repositoryId: string): string {
  return `repository:${repositoryId}`;
}

/** `refs/heads/feature/x` -> `feature/x`; anything that is not a branch ref -> null. */
function branchOfRef(ref: unknown): string | null {
  const value = String(ref ?? '');
  return value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : null;
}

/** GitHub spells "there was nothing here before" as forty zeroes, not as null. */
function shaOrNull(value: unknown): string | null {
  const sha = String(value ?? '');
  return !sha || /^0+$/.test(sha) ? null : sha;
}

/** Whether a stored event set already covers everything we ask GitHub for. */
function sameEvents(stored: string[] | null | undefined): boolean {
  if (!Array.isArray(stored)) return false;
  return HOOK_EVENTS.every((event) => stored.includes(event));
}

async function writeWebhookState(repository: AgentRepository, patch: Partial<RepositoryWebhookState>): Promise<void> {
  await repository.update({ webhook: { ...(repository.webhook ?? {}), ...patch } });
}

export class GithubWebhookService {
  /**
   * Reconcile one repository's hook with "is it still linked to any project".
   *
   * Called from the core (`lib/webhooks/repositoryWebhook.ts`) on every write to
   * `AgentProjectRepository`, so it has to be cheap and idempotent for the overwhelmingly common
   * case of "already installed, nothing to do".
   */
  static async syncWebhook(repository: AgentRepository, desired: boolean): Promise<void> {
    if (!desired) return this.removeWebhook(repository);

    const state = repository.webhook ?? {};
    const host = getWebhookHost();
    if (!host) {
      // Not an error to shout about: a deployment without the receiving layer is a supported
      // configuration whose whole cost is up to 15 minutes of latency.
      await writeWebhookState(repository, {
        hookId: null,
        lastError: 'Слой приёма вебхуков не смонтирован — репозиторий наблюдается опросом',
      });
      return;
    }

    let endpoint: { id: string; url: string };
    try {
      endpoint = await host.ensureEndpoint({
        kind: MAPPER_KIND,
        ownerKey: ownerKeyOf(repository.id),
        // Deliberately no projectId: the hook is the repository's, and the repository can be in two
        // projects at once. Which projects an event reaches is decided at publication, not here.
        projectId: null,
        config: { repositoryId: repository.id },
      });
    } catch (error) {
      await writeWebhookState(repository, {
        hookId: null,
        lastError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // Already installed at this URL with the events we want — the common path, and it must cost
    // no API call.
    if (state.hookId && state.url === endpoint.url && state.secret && sameEvents(state.events)) {
      if (state.lastError) await writeWebhookState(repository, { lastError: null });
      return;
    }

    // Installed and reachable, only the event set is behind (a repository linked before a fact was
    // added to `HOOK_EVENTS`). Patched in place rather than reinstalled: recreating would rotate
    // the secret, and a delivery in flight would then arrive unverifiable.
    if (state.hookId && state.url === endpoint.url && state.secret) {
      const upgraded = await this.upgradeHookEvents(repository, state.hookId);
      if (upgraded) return;
      // Could not patch — fall through and reinstall, which is the pre-existing behaviour for
      // every other reason a hook is not what we want.
    }

    const connection = await AgentGitConnection.findByPk(repository.connectionId);
    if (!connection || connection.status !== 'active') {
      await writeWebhookState(repository, {
        endpointId: endpoint.id, url: endpoint.url, hookId: null,
        lastError: 'Подключение GitHub неактивно — хук не поставлен, работает опрос',
      });
      return;
    }
    // `AgentGitConnection.scope` is what the token *actually* got, which an organisation policy can
    // narrow below what we asked for. Checked rather than assumed, because the failure otherwise
    // arrives as a 404 from the hooks endpoint and reads like a missing repository.
    const scopes = (connection.scope ?? '').split(/[,\s]+/).filter(Boolean);
    if (scopes.length > 0 && !scopes.includes('repo') && !scopes.includes('write:repo_hook')) {
      await writeWebhookState(repository, {
        endpointId: endpoint.id, url: endpoint.url, hookId: null,
        lastError: `У подключения урезан скоуп (${connection.scope}) — нужен repo или write:repo_hook;`
          + ' хук не поставлен, репозиторий наблюдается опросом',
      });
      return;
    }

    const secret = randomBytes(32).toString('hex');
    try {
      const client = await GithubOAuthService.apiClientFor(connection);
      // Drop whatever we installed before pointing at this endpoint: a moved public URL would
      // otherwise leave GitHub delivering to an address that answers 404 forever.
      for (const hook of await client.listHooks(repository.owner, repository.repo)) {
        const url = hook.config?.url ?? '';
        if (url.includes(`/hooks/v1/${endpoint.id}`) || (state.hookId && String(hook.id) === state.hookId)) {
          await client.deleteHook(repository.owner, repository.repo, String(hook.id)).catch((): undefined => undefined);
        }
      }
      const created = await client.createHook(repository.owner, repository.repo, {
        url: endpoint.url,
        secret,
        events: HOOK_EVENTS,
      });
      // The secret is stored *before* the ping, or a delivery that races the write arrives with
      // nothing to check it against.
      await writeWebhookState(repository, {
        hookId: String(created.id),
        endpointId: endpoint.id,
        url: endpoint.url,
        secret,
        events: [...HOOK_EVENTS],
        installedAt: new Date().toISOString(),
        lastError: null,
      });
      // Turns "хук создан" into "хук доставляется": a server GitHub cannot reach fails here,
      // in front of whoever just linked the repository, rather than at the first real push.
      await client.pingHook(repository.owner, repository.repo, String(created.id));
    } catch (error) {
      await writeWebhookState(repository, {
        endpointId: endpoint.id,
        url: endpoint.url,
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Bring an existing hook's event set up to `HOOK_EVENTS`. Answers whether it worked; a failure
   * is left for the caller to handle by reinstalling, and is not written as an error state on its
   * own — the hook still delivers what it always did.
   */
  private static async upgradeHookEvents(repository: AgentRepository, hookId: string): Promise<boolean> {
    const connection = await AgentGitConnection.findByPk(repository.connectionId);
    if (!connection || connection.status !== 'active') return false;
    try {
      const client = await GithubOAuthService.apiClientFor(connection);
      await client.updateHook(repository.owner, repository.repo, hookId, { events: HOOK_EVENTS });
      await writeWebhookState(repository, { events: [...HOOK_EVENTS], lastError: null });
      return true;
    } catch {
      return false;
    }
  }

  /** The last project link went away: take the hook down and forget the endpoint. */
  static async removeWebhook(repository: AgentRepository): Promise<void> {
    const state = repository.webhook;
    if (state?.hookId) {
      try {
        const connection = await AgentGitConnection.findByPk(repository.connectionId);
        if (connection && connection.status === 'active') {
          const client = await GithubOAuthService.apiClientFor(connection);
          await client.deleteHook(repository.owner, repository.repo, state.hookId);
        }
      } catch (error) {
        // A hook we could not delete upstream is somebody else's clutter, not our broken state:
        // the endpoint goes away regardless, so the deliveries stop being accepted either way.
        console.warn(
          `[app-agentiz-github-integration] could not delete hook ${state.hookId} on ${repository.pathWithNamespace}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    await getWebhookHost()?.removeEndpoint(ownerKeyOf(repository.id)).catch((): undefined => undefined);
    if (state) await repository.update({ webhook: null });
  }
}

/** The repository behind one delivery, resolved from the endpoint's own config. */
async function repositoryOf(ctx: WebhookDeliveryContext): Promise<AgentRepository | null> {
  const repositoryId = String(ctx.endpoint.config?.repositoryId ?? '');
  if (!repositoryId) return null;
  return AgentRepository.findByPk(repositoryId);
}

/**
 * `X-Hub-Signature-256: sha256=<hmac>` over the **raw** body with the repository's own secret.
 *
 * Constant-time, and a length mismatch is a plain mismatch rather than a throw — `timingSafeEqual`
 * raises on differing lengths, which would turn a malformed header into a 500.
 */
function signatureValid(raw: Buffer, header: string | undefined, secret: string): boolean {
  const presented = String(header ?? '');
  if (!presented.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The mapper: one GitHub delivery -> the same core publisher the poll uses.
 *
 * It deliberately creates **no task** — that is a deviation from the base model of the webhook
 * layer, where a mapper's output is a task, and it is recorded in
 * `.ai-notes/project-webhook-api.md`. A repository event is not a request to do anything; what
 * happens next is the graph's decision, and `agentiz.task.create` is the node that makes it.
 */
export const githubRepositoryWebhookMapper: WebhookMapper = {
  kind: MAPPER_KIND,
  title: 'GitHub: события репозитория',
  description: 'push, workflow_run и package из репозитория, подключённого к проекту Agentiz',
  auth: 'mapper',

  async authenticate(ctx: WebhookDeliveryContext): Promise<boolean> {
    const repository = await repositoryOf(ctx);
    const secret = repository?.webhook?.secret;
    if (!secret) return false;
    return signatureValid(ctx.raw, ctx.headers['x-hub-signature-256'], secret);
  },

  async handle(ctx: WebhookDeliveryContext): Promise<WebhookMapResult | null> {
    const repository = await repositoryOf(ctx);
    if (!repository) return { outcome: 'ignored', detail: 'Репозиторий этого эндпоинта уже удалён' };
    const event = ctx.headers['x-github-event'] ?? '';
    const body = (ctx.body ?? {}) as Record<string, any>;

    await repository.update({
      webhook: { ...(repository.webhook ?? {}), lastDeliveryAt: new Date().toISOString(), lastError: null },
    });

    if (event === 'ping') return { outcome: 'ignored', detail: 'ping — хук установлен и доставляется' };

    if (event === 'push') {
      const branch = branchOfRef(body.ref);
      if (!branch) return { outcome: 'ignored', detail: `не ветка: ${body.ref}` };
      if (body.deleted === true) {
        // No event for a deleted branch — see `forgetBranch`. The head is dropped so that a branch
        // recreated later reads as new rather than as a force-push from a head that is gone.
        await forgetBranch(repository, branch);
        return { outcome: 'accepted', detail: `ветка ${branch} удалена, голова забыта` };
      }
      const publication = await publishRepositoryPush(repository, {
        branch,
        beforeSha: shaOrNull(body.before),
        afterSha: String(body.after ?? ''),
        forced: body.forced === true,
        // Present in the delivery already, which is why the fast path never needs `/compare`.
        commits: (Array.isArray(body.commits) ? body.commits : []).map((commit: any) => ({
          sha: String(commit?.id ?? ''),
          message: String(commit?.message ?? ''),
          author: String(commit?.author?.username ?? commit?.author?.name ?? ''),
          url: String(commit?.url ?? ''),
        })),
        compareUrl: body.compare ? String(body.compare) : null,
      });
      return {
        outcome: 'accepted',
        detail: `push в ${branch}, событий в проекты: ${publication.emitted}`,
        data: { emitted: publication.emitted },
      };
    }

    if (event === 'workflow_run') {
      // `action: completed` only: a started or requested run has no conclusion, and "начался CI"
      // is not a fact a graph can act on.
      if (body.action !== 'completed') return { outcome: 'ignored', detail: `workflow_run: ${body.action}` };
      const run = body.workflow_run ?? {};
      const publication = await publishRepositoryCiRun(repository, {
        branch: String(run.head_branch ?? ''),
        headSha: String(run.head_sha ?? ''),
        workflowName: String(run.name ?? body.workflow?.name ?? ''),
        conclusion: String(run.conclusion ?? 'neutral'),
        url: String(run.html_url ?? ''),
        externalRunId: String(run.id ?? ''),
      });
      return {
        outcome: 'accepted',
        detail: `CI ${run.conclusion} на ${run.head_branch}, событий в проекты: ${publication.emitted}`,
        data: { emitted: publication.emitted },
      };
    }

    if (event === 'package' || event === 'registry_package') {
      // `published` = a new version, `updated` = the same version re-tagged or re-described. Both
      // are facts a graph can act on; anything else (a deletion, for one) is not, and inventing an
      // event for it would reach nodes that cannot express it.
      if (body.action !== 'published' && body.action !== 'updated') {
        return { outcome: 'ignored', detail: `package: ${body.action}` };
      }
      const pkg = body.package ?? {};
      const version = pkg.package_version ?? {};
      const container = version.container_metadata ?? {};
      // The digest lives in two places depending on how the version was published, and for a
      // container the version's own name *is* the digest. Preferring the tag's copy keeps the
      // reading right for a multi-arch index, where that is the index digest.
      const digest = String(container.tag?.digest ?? (String(version.name ?? '').startsWith('sha256:') ? version.name : ''));
      const publication = await publishRepositoryPackage(repository, {
        packageName: String(pkg.name ?? ''),
        packageType: String(pkg.package_type ?? '').toLowerCase(),
        namespace: String(pkg.namespace ?? pkg.owner?.login ?? ''),
        action: String(body.action),
        version: String(version.version ?? version.name ?? ''),
        tag: String(container.tag?.name ?? ''),
        digest,
        packageUrl: String(version.package_url ?? ''),
        htmlUrl: String(version.html_url ?? pkg.html_url ?? ''),
      });
      return {
        outcome: 'accepted',
        detail: `пакет ${pkg.name}${container.tag?.name ? `:${container.tag.name}` : ''} (${body.action}),`
          + ` событий в проекты: ${publication.emitted}`,
        data: { emitted: publication.emitted },
      };
    }

    // GitHub sends more than we asked for when somebody edits the hook by hand; saying so in the
    // journal is the whole answer to "мы отправили, у вас пусто".
    return { outcome: 'ignored', detail: `событие ${event} не отслеживается` };
  },
};
