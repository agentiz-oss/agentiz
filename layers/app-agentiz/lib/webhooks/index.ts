/**
 * The seam between "somebody outside pushed something at us" and whoever knows what it means.
 *
 * Two registries, both owned by the core and both filled by other layers, for the same reason the
 * git-connection authorities are: the layer that *receives* a delivery (app-agentiz-webhooks) and
 * the layer that *understands* one (a provider integration) are different layers, and neither may
 * import the other.
 *
 * - **mappers** are contributed by whoever understands a sender's format. They are pure functions
 *   of one delivery: no network, no writes of their own — everything a mapper decides it says in
 *   its result. That is what makes a broken payload a `rejected` with a 400 and a journal line
 *   rather than a 500.
 * - **the host** is contributed by the receiving layer and is what lets a provider layer ask for a
 *   public URL to hand to a platform. It is optional on purpose: a checkout with no public address
 *   simply installs no hooks and runs on the poll, which is exactly local development.
 */

import type { AgentRepository } from '../../models/AgentRepository';

/** What a mapper is handed. The signature has already been checked before this is built. */
export interface WebhookDeliveryContext {
  /** Parsed JSON body, or `null` when the body was not JSON. */
  body: unknown;
  /** The bytes as they arrived — a signature is computed over these, never over a re-serialization. */
  raw: Buffer;
  headers: Record<string, string | undefined>;
  endpoint: {
    id: string;
    kind: string;
    projectId: string | null;
    config: Record<string, unknown>;
  };
}

/**
 * What one delivery amounted to.
 *
 * `outcome` is the journal's vocabulary and the HTTP answer at once: `accepted` (we acted on it),
 * `ignored` (understood and deliberately not acted on — a `ping`, an event type we do not watch),
 * `duplicate` (seen this delivery id before). A mapper that throws produces `rejected`.
 */
export interface WebhookMapResult {
  outcome: 'accepted' | 'ignored' | 'duplicate';
  /** One line for the delivery journal — this is what somebody reads when "у вас пусто". */
  detail?: string;
  /** Extra JSON for the sender's response body; ids of whatever was created belong here. */
  data?: Record<string, unknown>;
  /** Idempotency key of this delivery, when the sender provides one. */
  dedupeKey?: string;
}

export interface WebhookMapper {
  /** Value of `AgentWebhookEndpoint.kind` this mapper answers to. */
  kind: string;
  title: string;
  description?: string;
  /**
   * Who checks the sender.
   *
   * `endpoint` is the ordinary case: the receiving layer compares a bearer token or an HMAC
   * against the endpoint's own secret. `mapper` hands that decision over — needed when the secret
   * does not belong to the endpoint at all, which is exactly the repository-webhook case: the
   * secret was issued by us *to* the platform, per repository, and lives on `AgentRepository`.
   */
  auth: 'endpoint' | 'mapper';
  /** Only for `auth: 'mapper'`. Returning false answers 401 and journals a `rejected`. */
  authenticate?(ctx: WebhookDeliveryContext): Promise<boolean> | boolean;
  handle(ctx: WebhookDeliveryContext): Promise<WebhookMapResult | null> | WebhookMapResult | null;
}

/**
 * What a provider layer needs from the receiving layer to install a hook somewhere.
 *
 * Deliberately tiny: a public URL and the row behind it. Everything else about the delivery — the
 * raw body, the journal, the rate limit — is the receiving layer's business and no platform
 * integration should be able to reach into it.
 */
export interface WebhookHost {
  /**
   * An endpoint for this owner, created if absent and reused if not. `ownerKey` is what makes it
   * idempotent — for repository hooks it is `repository:<AgentRepository.id>`, so re-linking a
   * repository does not accumulate endpoints.
   */
  ensureEndpoint(input: {
    kind: string;
    ownerKey: string;
    projectId?: string | null;
    config?: Record<string, unknown>;
  }): Promise<{ id: string; url: string }>;
  /** Drop an endpoint and stop accepting deliveries on it. Missing is success. */
  removeEndpoint(ownerKey: string): Promise<void>;
  /** The public URL of an existing endpoint, or null when this deployment has no public address. */
  endpointUrl(endpointId: string): string | null;
}

const MAPPERS_KEY = Symbol.for('agentiz.webhookMappers');
const HOST_KEY = Symbol.for('agentiz.webhookHost');

function mapperRegistry(): Map<string, WebhookMapper> {
  const holder = globalThis as unknown as Record<symbol, Map<string, WebhookMapper>>;
  if (!holder[MAPPERS_KEY]) holder[MAPPERS_KEY] = new Map();
  return holder[MAPPERS_KEY];
}

export function registerWebhookMapper(mapper: WebhookMapper): void {
  mapperRegistry().set(mapper.kind, mapper);
}

export function unregisterWebhookMapper(kind: string): void {
  mapperRegistry().delete(kind);
}

export function getWebhookMapper(kind: string): WebhookMapper | undefined {
  return mapperRegistry().get(kind);
}

export function listWebhookMappers(): WebhookMapper[] {
  return [...mapperRegistry().values()];
}

export function registerWebhookHost(host: WebhookHost): void {
  (globalThis as unknown as Record<symbol, WebhookHost | null>)[HOST_KEY] = host;
}

export function unregisterWebhookHost(): void {
  (globalThis as unknown as Record<symbol, WebhookHost | null>)[HOST_KEY] = null;
}

/**
 * The receiving layer, or `null` when it is not installed.
 *
 * Callers must treat null as an ordinary state, not an error: "у этого развёртывания нет публичного
 * адреса" is a supported configuration, and what it costs is 15 minutes of latency, not a feature.
 */
export function getWebhookHost(): WebhookHost | null {
  return (globalThis as unknown as Record<symbol, WebhookHost | null>)[HOST_KEY] ?? null;
}

/** The webhook state of a repository with its delivery secret removed. Never serve the raw column. */
export function maskRepositoryWebhook(repository: AgentRepository): Record<string, unknown> | null {
  const webhook = repository.webhook;
  if (!webhook) return null;
  const { secret, ...rest } = webhook;
  return { ...rest, hasSecret: Boolean(secret) };
}
