import fs from 'fs';
import express, { type Router } from 'express';
import { AgentWorkerApiService, WorkerApiError } from '../services/AgentWorkerApiService';
import { AgentWorkerRegistryService, WorkerRegistryError } from '../services/AgentWorkerRegistryService';

/** Public base path of the machine-facing Worker API. */
export const WORKER_API_BASE = '/api/agentiz/worker/v1';

/** Worker API errors carry their own HTTP status; anything else is a 500 without internals. */
function workerErrorResponse(res: express.Response, error: unknown) {
  if (error instanceof WorkerApiError) {
    return res.status(error.status).json({ message: error.message });
  }
  if (error instanceof WorkerRegistryError) {
    return res.status(error.status).json({ message: error.message, code: error.code });
  }
  return res.status(500).json({ message: error instanceof Error ? error.message : String(error) });
}

/**
 * The Worker API is mounted on the root Express app, not through the `adminizerMiddlewares`
 * collection.
 *
 * That collection prefixes every route with Adminizer's `routePrefix` (`/dashboard`), which would
 * put a machine-to-machine API behind the admin panel's path and make the documented
 * `/api/agentiz/worker/v1/...` a 404. Workers authenticate with their own bearer token and have
 * nothing to do with admin sessions, so they get their own router.
 */
export function createWorkerApiRouter(): Router {
  const router = express.Router();
  // Workspace Git uploads a complete binary patch; the server applies its own stricter hard limit.
  router.use(express.json({ limit: '25mb' }));

  router.get(['/healthz', '/readyz'], (_req, res) => {
    res.json({ ok: true, workerApiEnabled: AgentWorkerApiService.isEnabled() });
  });

  // Lets a worker check what the server thinks of it (status, project allowlist) without claiming.
  router.get('/me', async (req, res) => {
    try {
      const worker = await AgentWorkerRegistryService.authenticate(req.header('authorization'), req.ip);
      res.json(AgentWorkerRegistryService.describe(worker));
    } catch (error) {
      workerErrorResponse(res, error);
    }
  });

  // Binds the process to the identity an admin created: authenticates with the worker's own token
  // and records the machine behind it. It issues nothing — tokens come from the admin panel.
  router.post('/register', async (req, res) => {
    try {
      res.json(await AgentWorkerRegistryService.register(req.body, req.header('authorization') ?? '', req.ip ?? null));
    } catch (error) {
      workerErrorResponse(res, error);
    }
  });

  // Usage telemetry, deliberately outside the job lease: a worker reports hardest exactly when it
  // holds no job. See AgentWorkerApiService.reportHarnessUsage.
  router.post('/harness-usage', async (req, res) => {
    try {
      res.json(await AgentWorkerApiService.reportHarnessUsage(req.body, req.header('authorization') ?? '', req.ip ?? null));
    } catch (error) {
      workerErrorResponse(res, error);
    }
  });

  router.post('/claims', async (req, res) => {
    try {
      const claim = await AgentWorkerApiService.claim(req.body, req.header('authorization') ?? '', req.ip ?? null);
      if (!claim) {
        res.status(204).send();
        return;
      }
      res.json(claim);
    } catch (error) {
      workerErrorResponse(res, error);
    }
  });

  router.post('/jobs/:jobId/heartbeat', async (req, res) => {
    try {
      res.json(await AgentWorkerApiService.heartbeat(req.params.jobId, req.body, req.header('authorization') ?? '', req.ip ?? null));
    } catch (error) {
      workerErrorResponse(res, error);
    }
  });

  // Express treats `:` as a literal in a path segment, so `events:batch` needs no escaping.
  router.post('/jobs/:jobId/events\\:batch', async (req, res) => {
    try {
      res.json(await AgentWorkerApiService.recordEvents(req.params.jobId, req.body, req.header('authorization') ?? '', req.ip ?? null));
    } catch (error) {
      workerErrorResponse(res, error);
    }
  });

  // Repository credentials for the job this worker currently holds. Deliberately not part of the
  // job snapshot — see AgentWorkerApiService.issueSecrets.
  router.post('/jobs/:jobId/secrets', async (req, res) => {
    try {
      res.json(await AgentWorkerApiService.issueSecrets(req.params.jobId, req.body, req.header('authorization') ?? '', req.ip ?? null));
    } catch (error) {
      workerErrorResponse(res, error);
    }
  });

  // Bytes of one task attachment, for the job this worker holds. A POST because the lease proof
  // travels in the body like on every other job endpoint; the response is the raw file.
  router.post('/jobs/:jobId/attachments/:attachmentId', async (req, res) => {
    try {
      const file = await AgentWorkerApiService.issueAttachment(
        req.params.jobId,
        req.params.attachmentId,
        req.body,
        req.header('authorization') ?? '',
        req.ip ?? null,
      );
      if (!fs.existsSync(file.diskPath)) {
        res.status(404).json({ message: 'Attachment file is missing on disk' });
        return;
      }
      res.setHeader('Content-Type', file.mimeType ?? 'application/octet-stream');
      res.setHeader('Content-Length', String(file.sizeBytes));
      res.setHeader('X-Attachment-Filename', encodeURIComponent(file.fileName));
      fs.createReadStream(file.diskPath).pipe(res);
    } catch (error) {
      workerErrorResponse(res, error);
    }
  });

  router.post('/jobs/:jobId/interactions', async (req, res) => {
    try {
      res.json(await AgentWorkerApiService.createInteraction(req.params.jobId, req.body, req.header('authorization') ?? '', req.ip ?? null));
    } catch (error) {
      workerErrorResponse(res, error);
    }
  });

  router.post('/jobs/:jobId/interactions/:interactionId/wait', async (req, res) => {
    try {
      const answer = await AgentWorkerApiService.waitInteraction(
        req.params.jobId,
        req.params.interactionId,
        req.body,
        req.header('authorization') ?? '',
        req.ip ?? null,
      );
      if (!answer) return res.status(204).send();
      return res.json(answer);
    } catch (error) {
      return workerErrorResponse(res, error);
    }
  });

  router.post('/jobs/:jobId/interactions/:interactionId/ack', async (req, res) => {
    try {
      res.json(await AgentWorkerApiService.acknowledgeInteraction(
        req.params.jobId,
        req.params.interactionId,
        req.body,
        req.header('authorization') ?? '',
        req.ip ?? null,
      ));
    } catch (error) {
      workerErrorResponse(res, error);
    }
  });

  router.post('/jobs/:jobId/result', async (req, res) => {
    try {
      res.json(await AgentWorkerApiService.applyResult(req.params.jobId, req.body, req.header('authorization') ?? '', req.ip ?? null));
    } catch (error) {
      workerErrorResponse(res, error);
    }
  });

  router.post('/jobs/:jobId/release', async (req, res) => {
    try {
      res.json(await AgentWorkerApiService.release(req.params.jobId, req.body, req.header('authorization') ?? '', req.ip ?? null));
    } catch (error) {
      workerErrorResponse(res, error);
    }
  });

  return router;
}
