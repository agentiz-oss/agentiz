import express, { type Express, type RequestHandler } from 'express';

/** Where workers reach the server. Versioned: the path is configured on every worker machine. */
export const WORKER_API_BASE = '/api/agentiz/worker/v1';

/**
 * Ceiling on one worker request. A pipeline result carries the run's **complete** diff (every
 * operation with its content plus the binary patch), which outgrows a megabyte as soon as an agent
 * writes real documents; the server applies its own, stricter limits to what it stores.
 */
export const WORKER_API_MAX_BODY = process.env.AGENTIZ_WORKER_API_MAX_BODY ?? '25mb';

export function workerApiJsonBody(): RequestHandler {
  return express.json({ limit: WORKER_API_MAX_BODY });
}

/**
 * Must run **before** `appManager.init()`: init puts a global `express.json()` with app-manager's
 * own limit (`BODY_LIMIT`, default 1mb) ahead of every route, so the router's larger limit was
 * never reached — a result over a megabyte answered 413 before it got there. The worker cannot
 * report that 413 either (its failure report carries the same diff), crashes, comes back, claims
 * the same job and runs the agent again, until the lease budget buries it: that is how a
 * successful run on 2026-11-15 ended as "lease expired too many times" with its work in a stash.
 * Whichever parser reads a body first marks it consumed and the rest skip it, which is why
 * reserving the path here is enough. Free of models on purpose — the root `index.ts` imports it
 * before any layer loads.
 */
export function reserveWorkerApiBody(app: Express): void {
  app.use(WORKER_API_BASE, workerApiJsonBody());
}
