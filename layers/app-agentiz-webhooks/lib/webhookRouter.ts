import express, { type Router } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { UniqueConstraintError } from 'sequelize';
import { getWebhookMapper } from '../../app-agentiz/lib/webhooks';
import type { WebhookDeliveryContext, WebhookMapResult } from '../../app-agentiz/lib/webhooks';
import { AgentWebhookDelivery } from '../models/AgentWebhookDelivery';
import { AgentWebhookEndpoint } from '../models/AgentWebhookEndpoint';

/**
 * The public face of inbound webhooks: one POST per delivery, journalled whatever happens to it.
 *
 * Mounted on `appManager.app`, never through `adminizerMiddlewares` — that dispatcher prefixes
 * every route with Adminizer's `/dashboard`, and an external integrator would be sending into the
 * admin panel. Same placement and the same reason as the Worker API and the mobile API.
 *
 * The body is taken **raw** and parsed here. A signature is computed over the bytes that arrived,
 * and `JSON.parse` + `JSON.stringify` does not reproduce them — every sender that signs (GitHub,
 * Stripe, Sentry) signs the body as sent, so a global JSON parser upstream of this router would
 * make every signature fail with no way to tell why.
 */

/** Ceiling on one delivery. GitHub's own limit is 25 MB but its push payloads are far under this. */
const MAX_BODY = Number(process.env.AGENTIZ_WEBHOOK_MAX_BODY ?? 1024 * 1024);
/** How much of a body the journal keeps, so an unreadable payload can still be read back. */
const EXCERPT = Number(process.env.AGENTIZ_WEBHOOK_PAYLOAD_EXCERPT ?? 8 * 1024);

export function hashWebhookSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Constant-time compare of two hex digests; a length mismatch is a mismatch, not a throw. */
export function secretMatches(presented: string, storedHash: string | null): boolean {
  if (!storedHash) return false;
  const a = Buffer.from(hashWebhookSecret(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function headerMap(req: express.Request): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

/**
 * The delivery journal. Returns `true` when the row was written and `false` when this delivery id
 * has been seen before — the unique index is what decides, not a read-then-write, because two
 * copies of one re-delivery can arrive at the same instant.
 */
async function journal(input: {
  endpointId: string;
  outcome: string;
  dedupeKey: string | null;
  eventName: string | null;
  httpStatus: number;
  detail: string | null;
  raw: Buffer;
}): Promise<boolean> {
  try {
    await AgentWebhookDelivery.create({
      endpointId: input.endpointId,
      outcome: input.outcome,
      dedupeKey: input.dedupeKey,
      eventName: input.eventName,
      httpStatus: input.httpStatus,
      detail: input.detail?.slice(0, 2000) ?? null,
      payloadExcerpt: input.raw.subarray(0, EXCERPT).toString('utf8'),
    });
    return true;
  } catch (error) {
    if (error instanceof UniqueConstraintError) return false;
    throw error;
  }
}

export function createWebhookRouter(): Router {
  const router = express.Router();
  // `type: () => true` rather than a content-type list: a sender that labels JSON as
  // `application/x-www-form-urlencoded` (some do) must still reach the mapper with its bytes intact.
  router.use(express.raw({ limit: MAX_BODY, type: () => true }));

  /** Without a secret: is the receiving layer up at all. Answers nothing about any endpoint. */
  router.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  router.post('/:endpointId', async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const headers = headerMap(req);
    const eventName = headers['x-github-event'] ?? headers['x-event-name'] ?? null;
    const dedupeKey = headers['x-github-delivery'] ?? headers['idempotency-key'] ?? null;

    const endpoint = await AgentWebhookEndpoint.findByPk(String(req.params.endpointId));
    // 404 rather than 403 for "no such endpoint" *and* for "switched off": telling a stranger
    // which of the two it is tells them an endpoint exists.
    if (!endpoint || !endpoint.isActive) return res.status(404).json({ message: 'Not found' });

    const mapper = getWebhookMapper(endpoint.kind);
    if (!mapper) {
      await journal({
        endpointId: endpoint.id, outcome: 'rejected', dedupeKey, eventName, httpStatus: 503,
        detail: `Нет маппера "${endpoint.kind}" — слой, который его поставляет, не смонтирован`, raw,
      });
      return res.status(503).json({ message: 'Mapper unavailable' });
    }

    let body: unknown = null;
    try {
      body = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : null;
    } catch {
      // Not fatal by itself — a mapper may work off the raw bytes — so this is recorded and passed
      // on as `null` rather than refused here.
      body = null;
    }

    const ctx: WebhookDeliveryContext = {
      body,
      raw,
      headers,
      endpoint: {
        id: endpoint.id,
        kind: endpoint.kind,
        projectId: endpoint.projectId,
        config: endpoint.config ?? {},
      },
    };

    // Authentication. `endpoint` is the ordinary case; `mapper` hands the decision to whoever owns
    // the secret — for repository hooks that is the repository row, not this endpoint.
    let authenticated = false;
    if (mapper.auth === 'mapper') {
      authenticated = Boolean(await mapper.authenticate?.(ctx));
    } else {
      const presented = (headers.authorization ?? '').replace(/^Bearer\s+/i, '')
        || headers['x-agentiz-webhook-key'] || '';
      authenticated = Boolean(presented) && secretMatches(presented, endpoint.secretHash);
    }
    if (!authenticated) {
      await journal({
        endpointId: endpoint.id, outcome: 'rejected', dedupeKey, eventName, httpStatus: 401,
        detail: 'Подпись или ключ не сошлись', raw,
      });
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // The journal row goes in **before** the mapper runs, and its unique index is what makes a
    // re-delivery idempotent: a second copy of the same `X-GitHub-Delivery` loses the insert and
    // is answered 200 without the mapper ever being called a second time.
    if (dedupeKey) {
      const fresh = await journal({
        endpointId: endpoint.id, outcome: 'received', dedupeKey, eventName, httpStatus: 200,
        detail: null, raw,
      });
      if (!fresh) return res.json({ accepted: true, duplicate: true });
    }

    let result: WebhookMapResult | null = null;
    try {
      result = await mapper.handle(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A payload the mapper could not make sense of is a fact about the sender, not a server
      // fault: 400 plus a journal line, never a 500.
      await recordOutcome(endpoint, dedupeKey, { outcome: 'rejected', detail: message }, eventName, raw, 400);
      return res.status(400).json({ message });
    }

    const outcome = result ?? { outcome: 'ignored' as const, detail: 'Маппер не заинтересовался этой доставкой' };
    const status = outcome.outcome === 'ignored' ? 200 : 200;
    await recordOutcome(endpoint, dedupeKey, outcome, eventName, raw, status);
    return res.status(status).json({ accepted: outcome.outcome === 'accepted', ...outcome.data });
  });

  return router;
}

/** Update the pre-written journal row (or write one when the sender numbered nothing) and the endpoint. */
async function recordOutcome(
  endpoint: AgentWebhookEndpoint,
  dedupeKey: string | null,
  result: { outcome: string; detail?: string },
  eventName: string | null,
  raw: Buffer,
  httpStatus: number,
): Promise<void> {
  if (dedupeKey) {
    await AgentWebhookDelivery.update(
      { outcome: result.outcome, detail: result.detail?.slice(0, 2000) ?? null, httpStatus },
      { where: { endpointId: endpoint.id, dedupeKey } },
    );
  } else {
    await journal({
      endpointId: endpoint.id, outcome: result.outcome, dedupeKey: null, eventName,
      httpStatus, detail: result.detail ?? null, raw,
    });
  }
  await endpoint.update({
    lastDeliveryAt: new Date(),
    deliveryCount: (endpoint.deliveryCount ?? 0) + 1,
    lastError: result.outcome === 'rejected' ? (result.detail ?? 'rejected') : null,
  });
}
