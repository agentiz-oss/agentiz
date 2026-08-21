import { createHash, randomBytes } from 'crypto';
import { Op } from 'sequelize';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentWorker } from '../models/AgentWorker';
import { AgentProject } from '../models/AgentProject';
import type {
  AgentWorkerCapabilities,
  AgentWorkerExecutor,
  AgentWorkerKind,
  AgentWorkerStatus,
  AgentWorkerWorkspace,
} from '../types/agentiz';
import { isUnderGitPushRoot, normalizeGitPushRoot } from '../lib/workspaceGit';

const SCHEMA_VERSION = 1;
const TOKEN_PREFIX = 'agw_';
/** How much of the token is stored in clear text so an admin can tell two workers apart. */
const VISIBLE_PREFIX_LENGTH = TOKEN_PREFIX.length + 8;

export class WorkerRegistryError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export function hashWorkerToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function issueToken(): { token: string; tokenHash: string; tokenPrefix: string } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
  return { token, tokenHash: hashWorkerToken(token), tokenPrefix: token.slice(0, VISIBLE_PREFIX_LENGTH) };
}

function bearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1].trim() : null;
}

function optionalString(value: unknown, max = 200): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export interface RegisterWorkerInput {
  schemaVersion?: number;
  instanceId?: unknown;
  version?: unknown;
  hostname?: unknown;
  capabilities?: unknown;
}

export interface RegisterWorkerResult {
  schemaVersion: number;
  workerId: string;
  name: string;
  status: AgentWorkerStatus;
  tokenPrefix: string | null;
  allowedProjectIds: string[] | null;
  allowedRepositoryIds: string[] | null;
  message: string;
}

export interface CreateWorkerInput {
  name: string;
  allowedProjectIds?: string[] | null;
  createdBy?: string | null;
}

/**
 * Owns worker identities: creation, personal tokens, pausing and revocation.
 *
 * Trust model, borrowed from GitLab runners: a worker exists only because an admin created it in
 * the panel, and its token is shown exactly once at that moment. There is no shared enrollment
 * secret and no self-service registration — `POST /register` authenticates with the worker's own
 * token and merely records which machine is using it. That keeps a single, auditable answer to
 * "who may read task snapshots and repository data": whoever the admin handed a token to.
 */
export class AgentWorkerRegistryService {
  /**
   * Creates a worker and issues its token. The plain token is returned once and never again — the
   * database only ever holds its hash.
   */
  static async create(input: CreateWorkerInput): Promise<{ worker: AgentWorker; token: string }> {
    const name = optionalString(input.name);
    if (!name) throw new WorkerRegistryError(400, 'name is required', 'bad_request');
    const issued = issueToken();
    const worker = await AgentWorker.create({
      name,
      instanceId: null,
      kind: 'external' as AgentWorkerKind,
      status: 'active',
      tokenHash: issued.tokenHash,
      tokenPrefix: issued.tokenPrefix,
      tokenIssuedAt: new Date(),
      allowedProjectIds: input.allowedProjectIds?.length ? input.allowedProjectIds : null,
      createdBy: optionalString(input.createdBy),
    });
    console.log(`[AgentizWorkerRegistry] worker "${name}" created by ${worker.createdBy ?? 'admin'}`);
    return { worker, token: issued.token };
  }

  /**
   * Binds a running process to its worker record: the caller proves it holds the token, and tells
   * the panel which machine, version and capabilities are behind it.
   *
   * Nothing here grants access — the token already did. Re-registering is normal (every restart
   * does it) and simply refreshes the metadata.
   */
  static async register(body: unknown, authHeader: string | undefined, ip?: string | null): Promise<RegisterWorkerResult> {
    const payload = (body ?? {}) as RegisterWorkerInput;
    if (payload.schemaVersion !== SCHEMA_VERSION) {
      throw new WorkerRegistryError(400, 'Unsupported schemaVersion', 'bad_schema');
    }
    const instanceId = optionalString(payload.instanceId);
    if (!instanceId) throw new WorkerRegistryError(400, 'instanceId is required', 'bad_request');

    const worker = await this.authenticate(authHeader, ip);

    // Two machines started with the same token would fight over one identity — and one of them
    // would silently overwrite the other's telemetry. Make the admin issue a second worker.
    const conflict = await AgentWorker.findOne({ where: { instanceId, id: { [Op.ne]: worker.id } } });
    if (conflict) {
      throw new WorkerRegistryError(
        409,
        `instanceId "${instanceId}" already belongs to worker "${conflict.name}"`,
        'instance_taken',
      );
    }

    const firstContact = !worker.registeredAt;
    const capabilities = payload.capabilities && typeof payload.capabilities === 'object' && !Array.isArray(payload.capabilities)
      ? (payload.capabilities as AgentWorkerCapabilities)
      : null;
    await worker.update({
      instanceId,
      version: optionalString(payload.version, 50),
      hostname: optionalString(payload.hostname),
      lastIp: optionalString(ip, 64),
      capabilities,
      // The machine's zone, when the worker reports it. Limit providers parse local reset times
      // ("resets 3am") with it; an operator-set value is never overwritten by the report.
      ...(worker.timezone ? {} : { timezone: optionalString(capabilities?.timezone, 64) }),
      lastSeenAt: new Date(),
      ...(firstContact ? { registeredAt: new Date() } : {}),
    });
    console.log(`[AgentizWorkerRegistry] worker "${worker.name}" connected from ${instanceId}`);
    return this.describe(
      worker,
      firstContact ? 'Worker connected' : 'Worker re-announced',
    );
  }

  /** Resolves the caller's personal token to a worker. Throws for unknown or revoked tokens. */
  static async authenticate(authHeader: string | undefined, ip?: string | null): Promise<AgentWorker> {
    const presented = bearer(authHeader);
    if (!presented) throw new WorkerRegistryError(401, 'Bearer worker token is required', 'unauthorized');
    const worker = await AgentWorker.findOne({ where: { tokenHash: hashWorkerToken(presented) } });
    if (!worker) throw new WorkerRegistryError(401, 'Unknown worker token', 'unauthorized');
    if (worker.status === 'revoked') throw new WorkerRegistryError(401, 'Worker token is revoked', 'revoked');
    const patch: Record<string, unknown> = { lastSeenAt: new Date() };
    const remoteIp = optionalString(ip, 64);
    if (remoteIp && remoteIp !== worker.lastIp) patch.lastIp = remoteIp;
    await worker.update(patch);
    return worker;
  }

  /** Authenticates and additionally requires the worker to be cleared for job traffic. */
  static async authenticateActive(authHeader: string | undefined, ip?: string | null): Promise<AgentWorker> {
    const worker = await this.authenticate(authHeader, ip);
    if (worker.status === 'paused') {
      throw new WorkerRegistryError(403, 'Worker is paused', 'paused');
    }
    if (worker.status !== 'active') {
      throw new WorkerRegistryError(403, `Worker is ${worker.status}`, 'not_active');
    }
    return worker;
  }

  static describe(worker: AgentWorker, message = ''): RegisterWorkerResult {
    return {
      schemaVersion: SCHEMA_VERSION,
      workerId: worker.id,
      name: worker.name,
      status: worker.status,
      tokenPrefix: worker.tokenPrefix,
      allowedProjectIds: worker.allowedProjectIds ?? null,
      // Reported to the worker so its own log can say what it is allowed to take.
      allowedRepositoryIds: worker.allowedRepositoryIds ?? null,
      message,
    };
  }

  // --- admin operations -------------------------------------------------------------------

  static async list(): Promise<AgentWorker[]> {
    return AgentWorker.findAll({ order: [['createdAt', 'DESC']] });
  }

  /** Stops handing out jobs while keeping the identity and its token intact. */
  static async pause(workerId: string, reason?: string | null): Promise<AgentWorker> {
    const worker = await this.require(workerId);
    if (worker.status === 'revoked') throw new WorkerRegistryError(409, 'Revoked worker cannot be paused', 'revoked');
    await worker.update({ status: 'paused', revokedReason: reason ?? null });
    await this.releaseActiveJobs(worker, reason ?? 'worker paused');
    return worker;
  }

  static async resume(workerId: string): Promise<AgentWorker> {
    const worker = await this.require(workerId);
    if (worker.status === 'revoked') throw new WorkerRegistryError(409, 'Revoked worker cannot be resumed', 'revoked');
    await worker.update({ status: 'active', revokedReason: null });
    return worker;
  }

  /** Kills the token for good: the worker can authenticate no more and its leases go back to the queue. */
  static async revoke(workerId: string, reason?: string | null): Promise<AgentWorker> {
    const worker = await this.require(workerId);
    await worker.update({
      status: 'revoked',
      tokenHash: null,
      tokenPrefix: null,
      revokedAt: new Date(),
      revokedReason: reason ?? null,
    });
    await this.releaseActiveJobs(worker, reason ?? 'worker revoked');
    console.log(`[AgentizWorkerRegistry] worker ${worker.name} revoked`);
    return worker;
  }

  /**
   * Removes the record entirely, the way a GitLab runner is deleted. Anything it still held goes
   * back to the queue first, so deleting a busy worker cannot strand its jobs.
   */
  static async remove(workerId: string): Promise<void> {
    const worker = await this.require(workerId);
    if (worker.kind === 'local') {
      throw new WorkerRegistryError(409, 'The in-process worker is managed by the server, not the panel', 'local_worker');
    }
    await this.releaseActiveJobs(worker, 'worker deleted');
    await worker.destroy();
    console.log(`[AgentizWorkerRegistry] worker ${worker.name} deleted`);
  }

  /** Issues a new token; the previous one stops working immediately. */
  static async rotateToken(workerId: string): Promise<{ worker: AgentWorker; token: string }> {
    const worker = await this.require(workerId);
    if (worker.status === 'revoked') throw new WorkerRegistryError(409, 'Revoked worker cannot get a new token', 'revoked');
    const issued = issueToken();
    await worker.update({ tokenHash: issued.tokenHash, tokenPrefix: issued.tokenPrefix, tokenIssuedAt: new Date() });
    return { worker, token: issued.token };
  }

  static async setAllowedProjects(workerId: string, allowedProjectIds: string[] | null): Promise<AgentWorker> {
    const worker = await this.require(workerId);
    await worker.update({ allowedProjectIds: allowedProjectIds?.length ? allowedProjectIds : null });
    return worker;
  }

  /** Empty list means "not restricted", exactly like the project allowlist above. */
  static async setAllowedRepositories(workerId: string, allowedRepositoryIds: string[] | null): Promise<AgentWorker> {
    const worker = await this.require(workerId);
    await worker.update({ allowedRepositoryIds: allowedRepositoryIds?.length ? allowedRepositoryIds : null });
    return worker;
  }

  /**
   * Declares which prepared directories on this machine a pipeline may run in.
   *
   * Keys are what pipelines store, so they are validated here: a duplicate or empty key would make
   * `source.workspace.workspaceKey` ambiguous or unresolvable at queue time. Paths are checked for
   * being absolute only — this server does not have the worker's filesystem, so existence is the
   * worker's own check.
   *
   * `projectId` is the operator's statement that this directory is one project's workspace: specs
   * of any other project are then refused, at save time and at queue time (`lib/workspaceOwnership.ts`).
   * It is validated against an existing project here — a typo would otherwise lock the directory
   * out of every project at once, and only at the next run.
   */
  static async setWorkspaces(workerId: string, workspaces: AgentWorkerWorkspace[] | null): Promise<AgentWorker> {
    const worker = await this.require(workerId);
    const cleaned: AgentWorkerWorkspace[] = [];
    for (const item of workspaces ?? []) {
      const key = String(item?.key ?? '').trim();
      const path = String(item?.path ?? '').trim();
      if (!key || !path) throw new WorkerRegistryError(400, 'Every workspace needs a key and a path', 'invalid_workspace');
      // A proposal's reservation is keyed by the declared key or, for a spec that named the directory
      // directly, by its absolute path. A key shaped like a path would let those two collide.
      if (key.startsWith('/')) {
        throw new WorkerRegistryError(400, `Workspace key "${key}" must not start with "/" — a key names the directory, it is not the path`, 'invalid_workspace');
      }
      if (!path.startsWith('/')) {
        throw new WorkerRegistryError(400, `Workspace "${key}": path must be absolute, got "${path}"`, 'invalid_workspace');
      }
      if (cleaned.some((existing) => existing.key === key)) {
        throw new WorkerRegistryError(400, `Duplicate workspace key "${key}"`, 'invalid_workspace');
      }
      const label = String(item?.label ?? '').trim();
      const description = String(item?.description ?? '').trim();
      const projectId = String(item?.projectId ?? '').trim();
      if (projectId && !(await AgentProject.findByPk(projectId))) {
        throw new WorkerRegistryError(400, `Workspace "${key}": project ${projectId} does not exist`, 'invalid_workspace');
      }
      let git: AgentWorkerWorkspace['git'];
      if (item?.git !== undefined) {
        if (!item.git || typeof item.git !== 'object' || item.git.pushEnabled !== true) {
          throw new WorkerRegistryError(400, `Workspace "${key}": git.pushEnabled must be true or git must be omitted`, 'invalid_workspace');
        }
        const remote = String(item.git.remote ?? 'origin').trim();
        if (!/^[A-Za-z0-9._-]+$/.test(remote)) {
          throw new WorkerRegistryError(400, `Workspace "${key}": invalid Git remote "${remote}"`, 'invalid_workspace');
        }
        git = { pushEnabled: true, remote };
      }
      cleaned.push({
        key, path,
        ...(label ? { label } : {}),
        ...(description ? { description } : {}),
        ...(projectId ? { projectId } : {}),
        ...(git ? { git } : {}),
      });
    }
    await worker.update({ workspaces: cleaned.length ? cleaned : null });
    return worker;
  }

  /**
   * States which part of this machine's filesystem a pipeline may push from.
   *
   * This is the whole Git grant for `worker_workspace` delivery: a spec names a directory below one
   * of these prefixes and that is enough, no second declaration under a key. It lives on the worker
   * because the directory holds that host's Git credentials while a spec can be authored by anybody
   * with panel or MCP access — see `lib/workspaceGit.ts`.
   *
   * `/` is refused: a grant that covers every path on the machine is indistinguishable from no
   * boundary at all, which is the thing this field exists to draw.
   */
  static async setGitPushRoots(workerId: string, roots: string[] | null): Promise<AgentWorker> {
    const worker = await this.require(workerId);
    const cleaned: string[] = [];
    for (const raw of roots ?? []) {
      const root = normalizeGitPushRoot(raw);
      if (!root) continue;
      if (!root.startsWith('/')) {
        throw new WorkerRegistryError(400, `Git push root must be absolute, got "${String(raw)}"`, 'invalid_git_push_root');
      }
      if (root === '/') {
        throw new WorkerRegistryError(400, 'Git push root "/" would cover the whole machine; name the directories that actually hold checkouts', 'invalid_git_push_root');
      }
      // A root already covered by another one adds nothing and only makes the grant harder to read.
      if (cleaned.some((existing) => isUnderGitPushRoot(root, existing))) continue;
      cleaned.push(root);
    }
    await worker.update({ gitPushRoots: cleaned.length ? cleaned : null });
    return worker;
  }

  /** Replaces the named ACP profiles that people may choose on a manual launch. */
  static async setManualExecutors(workerId: string, executors: AgentWorkerExecutor[] | null): Promise<AgentWorker> {
    const worker = await AgentWorker.findByPk(workerId);
    if (!worker) throw new WorkerRegistryError(404, 'Worker not found', 'not_found');
    if (worker.status === 'revoked') throw new WorkerRegistryError(409, 'Cannot configure a revoked worker', 'revoked');
    const cleaned: AgentWorkerExecutor[] = [];
    const keys = new Set<string>();
    for (const candidate of executors ?? []) {
      const key = optionalString(candidate?.key, 64);
      const title = optionalString(candidate?.title, 100);
      const command = candidate?.acpCommand;
      if (!key || !/^[a-z0-9][a-z0-9_-]*$/i.test(key)) {
        throw new WorkerRegistryError(400, 'Each executor needs a key using letters, numbers, _ or -', 'bad_executor');
      }
      if (keys.has(key)) throw new WorkerRegistryError(400, `Executor key "${key}" is duplicated`, 'bad_executor');
      if (!Array.isArray(command) || !command.length || !command.every((part) => typeof part === 'string' && !!part.trim())) {
        throw new WorkerRegistryError(400, `Executor "${key}" needs a non-empty acpCommand array`, 'bad_executor');
      }
      keys.add(key);
      cleaned.push({ key, ...(title ? { title } : {}), acpCommand: command.map((part) => part.trim()) });
    }
    await worker.update({ manualExecutors: cleaned.length ? cleaned : null });
    return worker;
  }

  /** Registers/refreshes the in-process worker so the admin list shows every executor, not only remote ones. */
  static async ensureLocalWorker(instanceId: string, name: string): Promise<AgentWorker> {
    const [worker] = await AgentWorker.findOrCreate({
      where: { instanceId },
      defaults: {
        instanceId,
        name,
        kind: 'local',
        status: 'active',
        tokenHash: null,
        tokenPrefix: null,
        registeredAt: new Date(),
        createdBy: 'system (in-process worker)',
        allowedProjectIds: null,
      },
    });
    await worker.update({ lastSeenAt: new Date() });
    return worker;
  }

  static async noteClaim(worker: AgentWorker): Promise<void> {
    await worker.update({ lastClaimAt: new Date(), claimedJobsCount: worker.claimedJobsCount + 1 });
  }

  private static async require(workerId: string): Promise<AgentWorker> {
    const worker = await AgentWorker.findByPk(workerId);
    if (!worker) throw new WorkerRegistryError(404, 'Worker not found', 'not_found');
    return worker;
  }

  /**
   * Jobs held by a worker that just lost its access must not stay locked until the lease expires.
   * They go straight back to `queued` (not `released`, which nothing re-queues on its own) so
   * another worker picks them up immediately.
   */
  private static async releaseActiveJobs(worker: AgentWorker, reason: string): Promise<void> {
    await AgentRunJob.update(
      {
        status: 'queued',
        workerId: null,
        leaseTokenHash: null,
        lockedUntil: null,
        availableAt: new Date(),
        lastError: `Lease dropped: ${reason}`,
      },
      { where: { workerId: worker.id, status: { [Op.in]: ['leased', 'running'] } } },
    );
  }
}
