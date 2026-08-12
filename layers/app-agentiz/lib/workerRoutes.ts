import type { AdminizerRouteMiddleware } from '@nodeknit/app-adminizer';
import { AgentWorkerApiService } from '../services/AgentWorkerApiService';
import { AgentWorkerRegistryService, WorkerRegistryError } from '../services/AgentWorkerRegistryService';
import { WORKER_API_BASE } from './workerApiRouter';
import { maskWorkerForUI } from './secrets';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Base URL a worker should dial. Behind a proxy the request host is the internal one, so an
 * explicitly configured public origin always wins — the panel pastes this into a copyable command.
 */
function workerApiUrl(req: any): string {
  const configured = process.env.AGENTIZ_PUBLIC_URL?.replace(/\/+$/, '');
  const origin = configured || `${req.protocol}://${req.get('host')}`;
  return `${origin}${WORKER_API_BASE}`;
}

/**
 * The workers screen: registering worker machines, watching whether they are still checking in,
 * and scoping what each one may claim. Split out of the project overview so a busy fleet does not
 * push the rest of the panel off screen.
 */
export const workerRoutes: AdminizerRouteMiddleware[] = [
  {
    route: '/agentiz-workers',
    method: 'get',
    handler: async (req, res) => {
      const method = str(req.query._method);

      if (method === 'getWorkers') {
        const workers = await AgentWorkerRegistryService.list();
        return res.json({
          data: workers.map(maskWorkerForUI),
          // The panel prints a ready-to-run register command, so it needs the URL the worker will
          // actually dial — the public origin when one is configured.
          meta: {
            workerApiEnabled: AgentWorkerApiService.isEnabled(),
            workerApiUrl: workerApiUrl(req),
          },
        });
      }

      return req.Inertia.render({
        component: 'module',
        props: { moduleComponent: '/dashboard/modules/AgentizWorkers.js' },
      });
    },
  },
  {
    route: '/agentiz-workers',
    method: 'post',
    handler: async (req, res) => {
      try {
        const method = str(req.body?._method);

        if (method === 'createWorker') {
          try {
            const actor = (req as any).session?.UserAP?.login ?? (req as any).user?.login ?? 'admin';
            const projectIds = Array.isArray(req.body?.allowedProjectIds)
              ? req.body.allowedProjectIds.map((id: unknown) => String(id))
              : null;
            const created = await AgentWorkerRegistryService.create({
              name: str(req.body?.name),
              allowedProjectIds: projectIds,
              createdBy: String(actor),
            });
            // The token leaves the server exactly once, here: only its hash is stored.
            return res.json({
              data: {
                worker: maskWorkerForUI(created.worker),
                token: created.token,
                workerApiUrl: workerApiUrl(req),
              },
            });
          } catch (error) {
            if (error instanceof WorkerRegistryError) {
              return res.status(error.status).json({ message: error.message, code: error.code });
            }
            throw error;
          }
        }

        if (method === 'pauseWorker' || method === 'resumeWorker' || method === 'revokeWorker'
          || method === 'deleteWorker' || method === 'rotateWorkerToken' || method === 'setWorkerProjects'
          || method === 'setWorkerRepositories' || method === 'setWorkerWorkspaces'
          || method === 'setWorkerGitPushRoots' || method === 'setWorkerManualExecutors') {
          const workerId = str(req.body?.workerId);
          if (!workerId) return res.status(400).json({ message: 'workerId is required' });
          const reason = typeof req.body?.reason === 'string' ? req.body.reason : null;
          const projectIds = Array.isArray(req.body?.allowedProjectIds)
            ? req.body.allowedProjectIds.map((id: unknown) => String(id))
            : undefined;
          try {
            if (method === 'setWorkerWorkspaces') {
              const workspaces = Array.isArray(req.body?.workspaces) ? req.body.workspaces : [];
              const worker = await AgentWorkerRegistryService.setWorkspaces(workerId, workspaces);
              return res.json({ data: maskWorkerForUI(worker) });
            }
            if (method === 'setWorkerGitPushRoots') {
              const roots = Array.isArray(req.body?.gitPushRoots) ? req.body.gitPushRoots.map((item: unknown) => String(item)) : [];
              const worker = await AgentWorkerRegistryService.setGitPushRoots(workerId, roots);
              return res.json({ data: maskWorkerForUI(worker) });
            }
            if (method === 'setWorkerManualExecutors') {
              const executors = Array.isArray(req.body?.manualExecutors) ? req.body.manualExecutors : [];
              return res.json({ data: maskWorkerForUI(await AgentWorkerRegistryService.setManualExecutors(workerId, executors)) });
            }
            if (method === 'pauseWorker') {
              return res.json({ data: maskWorkerForUI(await AgentWorkerRegistryService.pause(workerId, reason)) });
            }
            if (method === 'resumeWorker') {
              return res.json({ data: maskWorkerForUI(await AgentWorkerRegistryService.resume(workerId)) });
            }
            if (method === 'revokeWorker') {
              return res.json({ data: maskWorkerForUI(await AgentWorkerRegistryService.revoke(workerId, reason)) });
            }
            if (method === 'deleteWorker') {
              await AgentWorkerRegistryService.remove(workerId);
              return res.json({ data: { deleted: true } });
            }
            if (method === 'setWorkerProjects') {
              const worker = await AgentWorkerRegistryService.setAllowedProjects(workerId, projectIds ?? null);
              return res.json({ data: maskWorkerForUI(worker) });
            }
            if (method === 'setWorkerRepositories') {
              const repositoryIds = Array.isArray(req.body?.allowedRepositoryIds)
                ? req.body.allowedRepositoryIds.map((id: unknown) => String(id))
                : null;
              const worker = await AgentWorkerRegistryService.setAllowedRepositories(workerId, repositoryIds);
              return res.json({ data: maskWorkerForUI(worker) });
            }
            // The rotated token is returned exactly once: it is stored only as a hash.
            const rotated = await AgentWorkerRegistryService.rotateToken(workerId);
            return res.json({
              data: {
                worker: maskWorkerForUI(rotated.worker),
                token: rotated.token,
                workerApiUrl: workerApiUrl(req),
              },
            });
          } catch (error) {
            if (error instanceof WorkerRegistryError) {
              return res.status(error.status).json({ message: error.message, code: error.code });
            }
            throw error;
          }
        }

        return res.status(400).json({ message: `Unknown _method: ${method || '(none)'}` });
      } catch (error: any) {
        return res.status(400).json({ message: error?.message ?? String(error) });
      }
    },
  },
];
