import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import { WORKER_API_BASE, reserveWorkerApiBody } from './workerApiBody';

/**
 * A worker's result is one JSON body carrying the run's whole diff. The Worker API router allows
 * 25mb, but in production app-manager's global `express.json()` (1mb by default) sits in front of
 * every route and answered 413 first — so the router's limit was never what applied. These tests
 * build the app in the order the root `index.ts` does, because a test that mounts the router on a
 * bare express app passes either way (the same lesson as the webhook raw body).
 */

const servers: Array<ReturnType<express.Express['listen']>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

/** Reservation (when asked), app-manager's global parsers with their default limit, then a route. */
async function productionShaped(reserve: boolean): Promise<string> {
  const app = express();
  if (reserve) reserveWorkerApiBody(app);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.post(`${WORKER_API_BASE}/jobs/:jobId/result`, (req, res) => {
    res.json({ received: String((req.body as { diff?: string }).diff ?? '').length });
  });
  const server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${WORKER_API_BASE}/jobs/j1/result`;
}

/** About the size of the 2026-11-15 run that was buried: 34 operations, +1765 lines. */
const bigResult = JSON.stringify({ status: 'succeeded', diff: 'x'.repeat(3 * 1024 * 1024) });

function post(url: string): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bigResult });
}

describe('worker API request body', () => {
  it('accepts a result larger than the global limit once the path is reserved', async () => {
    const response = await post(await productionShaped(true));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: 3 * 1024 * 1024 });
  });

  it('without the reservation the global parser answers 413 — the production failure', async () => {
    expect((await post(await productionShaped(false))).status).toBe(413);
  });
});
