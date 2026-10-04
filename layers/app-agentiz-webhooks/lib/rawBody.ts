import express, { type Express, type RequestHandler } from 'express';

/**
 * Where an external sender reaches us. Versioned in the path, because this URL ends up configured
 * inside somebody else's system and cannot be changed by a deploy.
 */
export const WEBHOOK_API_BASE = '/api/agentiz/hooks/v1';

/** Ceiling on one delivery. GitHub's own limit is 25 MB but its push payloads are far under this. */
export const MAX_WEBHOOK_BODY = Number(process.env.AGENTIZ_WEBHOOK_MAX_BODY ?? 1024 * 1024);

export function rawWebhookBody(): RequestHandler {
  // `type: () => true` rather than a content-type list: a sender that labels JSON as
  // `application/x-www-form-urlencoded` (some do) must still reach the mapper with its bytes intact.
  return express.raw({ limit: MAX_WEBHOOK_BODY, type: () => true });
}

/**
 * Must run **before** `appManager.init()`, which puts a global `express.json()` and
 * `express.urlencoded()` on the app ahead of every route: whichever parser reads a body first
 * marks it consumed and the rest skip it, so without this the router behind it receives an
 * already-parsed object, the signature is computed over nothing and every signed delivery is 401.
 * Free of models and decorators on purpose — the root `index.ts` imports it before any layer loads.
 */
export function reserveRawWebhookBody(app: Express): void {
  app.use(WEBHOOK_API_BASE, rawWebhookBody());
}
