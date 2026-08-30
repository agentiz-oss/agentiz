import type { AdminizerRouteMiddleware } from '@nodeknit/app-adminizer';
import { AgentHarnessSubscription } from '../models/AgentHarnessSubscription';
import { AgentWorkerApiService } from '../services/AgentWorkerApiService';
import { AgentWorkerRegistryService, WorkerRegistryError } from '../services/AgentWorkerRegistryService';
import { AgentHarnessAdminService, HarnessAdminError } from '../services/AgentHarnessAdminService';
import { subscriptionView, usageHistory, workerHarnessView } from './capacityViews';
import { WORKER_API_BASE } from './workerApiRouter';
import { maskWorkerForUI } from './secrets';
import { guardGlobal, requirePanelUser } from './access/panelGuard';
import { GLOBAL_TOKENS } from './access/tokens';

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
 *
 * A worker belongs to no project — it is a machine the whole installation shares, which is why the
 * access graph does not cover `AgentWorker` and why the boundary here is the **global**
 * `agentiz-workers-manage` token rather than a project right. Reading the fleet needs only a panel
 * session: an operator has to be able to see that a run is parked because no worker is online, and
 * `maskWorkerForUI` already keeps the tokens out of the payload.
 */

/** Installation-wide, like the fleet itself. Reads are not gated by it; every write is. */
function mayManageWorkers(req: any, res: any): boolean {
  return guardGlobal(req, res, GLOBAL_TOKENS.workersManage, 'Недостаточно прав, чтобы управлять воркерами');
}
export const workerRoutes: AdminizerRouteMiddleware[] = [
  {
    route: '/agentiz-workers',
    method: 'get',
    handler: async (req, res) => {
      const method = str(req.query._method);
      if (!requirePanelUser(req, res)) return undefined;

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

      // The "Harness и лимиты" block: bindings + subscription state per worker, and the
      // cross-worker subscription list for the separate section on the same page.
      if (method === 'getCapacity') {
        const [workers, subscriptions] = await Promise.all([
          AgentWorkerRegistryService.list(),
          AgentHarnessSubscription.findAll({ order: [['name', 'ASC']] }),
        ]);
        const harnesses: Record<string, unknown> = {};
        for (const worker of workers) {
          harnesses[worker.id] = await workerHarnessView(worker);
        }
        return res.json({ data: { harnesses, subscriptions: subscriptions.map(subscriptionView) } });
      }

      // Sample series for the usage chart of one worker × harness.
      if (method === 'getUsageHistory') {
        const workerId = str(req.query.workerId);
        const harnessKey = str(req.query.harnessKey);
        if (!workerId || !harnessKey) return res.status(400).json({ message: 'workerId and harnessKey are required' });
        const hours = Number(req.query.hours ?? 24);
        const from = new Date(Date.now() - Math.min(Math.max(hours, 1), 24 * 14) * 60 * 60 * 1000);
        return res.json({ data: await usageHistory({ workerId, harnessKey, from, limit: 1000 }) });
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
        if (!mayManageWorkers(req, res)) return undefined;

        // Harness limits and capacity: everything funnels through AgentHarnessAdminService.
        if (['setWorkerHarnessBindings', 'setWorkerLimits', 'markHarnessExhausted', 'clearHarnessLimit',
          'saveSubscription', 'deleteSubscription'].includes(method)) {
          try {
            if (method === 'setWorkerHarnessBindings') {
              const workerId = str(req.body?.workerId);
              const bindings = Array.isArray(req.body?.harnessBindings) ? req.body.harnessBindings : [];
              const saved = await AgentHarnessAdminService.setBindings(workerId, bindings);
              return res.json({ data: saved.map((binding) => binding.toJSON()) });
            }
            if (method === 'setWorkerLimits') {
              const worker = await AgentHarnessAdminService.setWorkerLimits(str(req.body?.workerId), {
                ...(('maxConcurrentJobs' in (req.body ?? {})) ? { maxConcurrentJobs: req.body.maxConcurrentJobs } : {}),
                ...(('activeHours' in (req.body ?? {})) ? { activeHours: req.body.activeHours } : {}),
                ...(('timezone' in (req.body ?? {})) ? { timezone: req.body.timezone } : {}),
              });
              return res.json({ data: maskWorkerForUI(worker) });
            }
            if (method === 'markHarnessExhausted') {
              const subscription = await AgentHarnessAdminService.markExhausted({
                workerId: str(req.body?.workerId) || undefined,
                subscriptionId: str(req.body?.subscriptionId) || undefined,
                harnessKey: str(req.body?.harnessKey) || undefined,
                until: new Date(str(req.body?.until)),
                reason: str(req.body?.reason) || undefined,
              });
              return res.json({ data: subscriptionView(subscription) });
            }
            if (method === 'clearHarnessLimit') {
              const subscription = await AgentHarnessAdminService.clearLimit({
                workerId: str(req.body?.workerId) || undefined,
                subscriptionId: str(req.body?.subscriptionId) || undefined,
                harnessKey: str(req.body?.harnessKey) || undefined,
                reason: str(req.body?.reason) || undefined,
              });
              return res.json({ data: subscriptionView(subscription) });
            }
            if (method === 'saveSubscription') {
              const id = str(req.body?.id) || undefined;
              const subscription = await AgentHarnessAdminService.saveSubscription(req.body?.values ?? {}, id);
              return res.json({ data: subscriptionView(subscription) });
            }
            await AgentHarnessAdminService.deleteSubscription(str(req.body?.subscriptionId));
            return res.json({ data: { deleted: true } });
          } catch (error) {
            if (error instanceof HarnessAdminError) return res.status(error.status).json({ message: error.message });
            throw error;
          }
        }

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
