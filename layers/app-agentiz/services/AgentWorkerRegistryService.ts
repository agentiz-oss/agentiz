import { createHash, randomBytes } from 'crypto';
import { Op } from 'sequelize';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentWorker } from '../models/AgentWorker';
import type { AgentWorkerCapabilities, AgentWorkerKind, AgentWorkerStatus } from '../types/agentiz';

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
    await worker.update({
      instanceId,
      version: optionalString(payload.version, 50),
      hostname: optionalString(payload.hostname),
      lastIp: optionalString(ip, 64),
      capabilities:
        payload.capabilities && typeof payload.capabilities === 'object' && !Array.isArray(payload.capabilities)
          ? (payload.capabilities as AgentWorkerCapabilities)
          : null,
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
