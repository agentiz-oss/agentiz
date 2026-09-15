import { Op } from 'sequelize';
import { AgentHarnessSubscription } from '../models/AgentHarnessSubscription';
import { AgentProject } from '../models/AgentProject';
import { AgentRepository } from '../models/AgentRepository';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentWorker } from '../models/AgentWorker';
import { AgentWorkerApiService } from '../services/AgentWorkerApiService';
import { AgentWorkerRegistryService } from '../services/AgentWorkerRegistryService';
import { hasGlobalToken, panelActor, requestAccessCache } from './access/panelGuard';
import { projectIdsForUser } from './access/projectAccess';
import { GLOBAL_TOKENS, PROJECT_TOKENS } from './access/tokens';
import { subscriptionView, workerHarnessView } from './capacityViews';
import { maskWorkerForUI } from './secrets';
import { WORKER_API_BASE } from './workerApiRouter';

/**
 * The read side of the fleet screens, in one place because it has two readers: the `_method`
 * endpoints the screen polls (`workerRoutes.ts`) and `lib/panel/render.ts`, which paints the first
 * frame from props. Two hand-kept assemblies of "what a worker looks like" is how a poll starts
 * showing a different machine than the page was opened with.
 *
 * It lives beside `runBoard.ts` and for the same reason: the panel renderer must not import the
 * route table, which drags in every service behind every screen.
 *
 * Nothing here decides anything — `AgentWorkerRegistryService` and `capacityViews` do. This only
 * adds what a list has to print and a model method cannot travel as JSON: the contact dot, the
 * concurrency cap actually in force, and how many jobs the machine is holding right now.
 */

/** Base URL a worker should dial. Behind a proxy the request host is the internal one, so an
 *  explicitly configured public origin always wins — the panel pastes this into a copyable command. */
export function workerApiUrl(req: any): string {
  const configured = process.env.AGENTIZ_PUBLIC_URL?.replace(/\/+$/, '');
  const origin = configured || `${req.protocol}://${req.get('host')}`;
  return `${origin}${WORKER_API_BASE}`;
}

/** Jobs each machine is holding at this instant, keyed by worker id. */
async function activeJobsByWorker(): Promise<Record<string, number>> {
  const rows = (await AgentRunJob.findAll({
    attributes: ['workerId', [AgentRunJob.sequelize!.fn('COUNT', '*'), 'count']],
    where: { status: { [Op.in]: ['leased', 'running'] }, workerId: { [Op.ne]: null } },
    group: ['workerId'],
    raw: true,
  })) as unknown as Array<{ workerId: string; count: string | number }>;
  return Object.fromEntries(rows.map((row) => [row.workerId, Number(row.count)]));
}

/**
 * One machine as the panel reads it: everything `maskWorkerForUI` keeps (the token hash is the
 * only thing dropped) plus the three derived facts above.
 *
 * `contactState` is the server's own answer rather than a timestamp comparison in the browser:
 * the claim gate uses this method, and a screen that draws its own dot from `lastSeenAt` starts
 * disagreeing with the queue the moment the threshold moves.
 */
export function workerForPanel(worker: AgentWorker, activeJobs: number): Record<string, unknown> {
  return {
    ...maskWorkerForUI(worker),
    contactState: worker.contactState(),
    effectiveMaxConcurrentJobs: worker.effectiveMaxConcurrentJobs(),
    activeJobs,
  };
}

/** The fleet, as `_method=getWorkers` answers it and as the first paint receives it. */
export async function listWorkers(fleet?: AgentWorker[]): Promise<Array<Record<string, unknown>>> {
  const [workers, jobs] = await Promise.all([fleet ?? AgentWorkerRegistryService.list(), activeJobsByWorker()]);
  return workers.map((worker) => workerForPanel(worker, jobs[worker.id] ?? 0));
}

/**
 * Bindings per worker plus the cross-worker subscriptions, as `_method=getCapacity` answers it.
 *
 * The fleet is a parameter so the first paint, which has already loaded it, does not read the
 * table twice; the endpoint passes nothing and loads it itself.
 */
export async function workerCapacity(
  fleet?: AgentWorker[],
): Promise<{ harnesses: Record<string, unknown>; subscriptions: unknown[] }> {
  const [workers, subscriptions] = await Promise.all([
    fleet ?? AgentWorkerRegistryService.list(),
    AgentHarnessSubscription.findAll({ order: [['name', 'ASC']] }),
  ]);
  const harnesses: Record<string, unknown> = {};
  for (const worker of workers) {
    harnesses[worker.id] = await workerHarnessView(worker);
  }
  return { harnesses, subscriptions: subscriptions.map(subscriptionView) };
}

/**
 * Everything the three fleet screens («Воркеры», one worker, «Обвязки и лимиты») open with.
 *
 * The names a worker's allowlists are written in come along, because an allowlist is stored as ids
 * and a screen that printed them raw would be unreadable. They are scoped exactly as the endpoints
 * that used to serve them: projects by `projectIdsForUser` (the same narrowing `_method=getProjects`
 * applies) and repositories only for a person who may manage connections — which is what
 * `_method=getRepositories` demands. An id outside those lists is printed as itself rather than
 * hidden: a worker may legitimately be scoped to a project this reader cannot open.
 *
 * `canManage` is the same global token the sidebar uses. It only decides whether the screen offers
 * the controls; every write is refused again by `mayManageWorkers` in the route, which is where the
 * decision actually is.
 */
export async function workerFleet(req: any): Promise<Record<string, unknown>> {
  const fleet = await AgentWorkerRegistryService.list();
  const [workers, capacity] = await Promise.all([listWorkers(fleet), workerCapacity(fleet)]);
  const projectIds = await projectIdsForUser(panelActor(req), PROJECT_TOKENS.read, requestAccessCache(req));
  const projects = await AgentProject.findAll({
    where: { id: projectIds },
    attributes: ['id', 'name', 'slug'],
    order: [['name', 'ASC']],
  });
  const repositories = hasGlobalToken(req, GLOBAL_TOKENS.connectionsManage)
    ? await AgentRepository.findAll({
      attributes: ['id', 'provider', 'pathWithNamespace', 'connectionId'],
      order: [['pathWithNamespace', 'ASC']],
      limit: 1000,
    })
    : [];

  return {
    workers,
    harnesses: capacity.harnesses,
    subscriptions: capacity.subscriptions,
    projects: projects.map((project) => ({ id: project.id, name: project.name, slug: project.slug })),
    repositories: repositories.map((repository) => ({
      id: repository.id,
      provider: repository.provider,
      pathWithNamespace: repository.pathWithNamespace,
      connectionId: repository.connectionId,
    })),
    workerApi: { enabled: AgentWorkerApiService.isEnabled(), url: workerApiUrl(req) },
    canManage: hasGlobalToken(req, GLOBAL_TOKENS.workersManage),
  };
}
