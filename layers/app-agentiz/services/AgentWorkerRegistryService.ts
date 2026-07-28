import { createHash, randomBytes, timingSafeEqual } from 'crypto';
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

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
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
  name?: unknown;
  version?: unknown;
  hostname?: unknown;
  capabilities?: unknown;
}

export interface RegisterWorkerResult {
  schemaVersion: number;
  workerId: string;
  status: AgentWorkerStatus;
  /** Present only when a token was issued — it is never retrievable afterwards. */
  token?: string;
  tokenPrefix: string | null;
  approved: boolean;
  allowedProjectIds: string[] | null;
  message: string;
}

/**
 * Owns worker identities: enrollment, personal tokens, approval and revocation.
 *
 * Trust model: the enrollment token (AGENTIZ_WORKER_ENROLLMENT_TOKEN) only buys the right to
 * create a *pending* worker record — it never grants access to jobs. Jobs are handed out solely
 * against a personal token bound to an `active` worker, so approving a worker in the admin panel
 * is the single point where someone decides who may see task snapshots and repository data.
 */
export class AgentWorkerRegistryService {
  static isAutoApproveEnabled(): boolean {
    return process.env.AGENTIZ_WORKER_AUTO_APPROVE === 'true';
  }

  private static enrollmentToken(): string {
    const token = process.env.AGENTIZ_WORKER_ENROLLMENT_TOKEN;
    if (!token) throw new WorkerRegistryError(503, 'AGENTIZ_WORKER_ENROLLMENT_TOKEN is not configured', 'enrollment_disabled');
    return token;
  }

  /**
   * Enrolls a worker and issues its personal token.
   *
   * Re-registration rules keep an approved identity from being taken over by anyone holding the
   * enrollment token: a known instanceId gets a fresh token only while it is still `pending`
   * (nothing to steal yet) or when the caller already proves possession of the current token.
   */
  static async register(body: unknown, authHeader: string | undefined, ip?: string | null): Promise<RegisterWorkerResult> {
    const payload = (body ?? {}) as RegisterWorkerInput;
    if (payload.schemaVersion !== SCHEMA_VERSION) {
      throw new WorkerRegistryError(400, 'Unsupported schemaVersion', 'bad_schema');
    }
    const instanceId = optionalString(payload.instanceId);
    if (!instanceId) throw new WorkerRegistryError(400, 'instanceId is required', 'bad_request');
    const name = optionalString(payload.name) ?? instanceId;
    const presented = bearer(authHeader);
    if (!presented) throw new WorkerRegistryError(401, 'Bearer token is required', 'unauthorized');

    const existing = await AgentWorker.findOne({ where: { instanceId } });
    const presentedHash = hashWorkerToken(presented);
    const isOwnToken = Boolean(existing?.tokenHash && constantTimeEquals(existing.tokenHash, presentedHash));
    const isEnrollment = !isOwnToken && constantTimeEquals(this.enrollmentToken(), presented);
    if (!isOwnToken && !isEnrollment) {
      throw new WorkerRegistryError(401, 'Invalid enrollment or worker token', 'unauthorized');
    }

    const attributes = {
      name,
      version: optionalString(payload.version, 50),
      hostname: optionalString(payload.hostname),
      lastIp: optionalString(ip, 64),
      capabilities: (payload.capabilities && typeof payload.capabilities === 'object' && !Array.isArray(payload.capabilities)
        ? payload.capabilities as AgentWorkerCapabilities
        : null),
      lastSeenAt: new Date(),
    };

    if (existing) {
      if (existing.status === 'revoked') {
        throw new WorkerRegistryError(403, 'This worker instance is revoked; ask an administrator to delete it before re-enrolling', 'revoked');
      }
      // An already-approved identity may only refresh its metadata, not silently get a new token
      // from whoever knows the enrollment token.
      if (isOwnToken) {
        await existing.update(attributes);
        return this.describe(existing, undefined, 'Worker re-announced with its existing token');
      }
      if (existing.status !== 'pending') {
        throw new WorkerRegistryError(
          409,
          'instanceId is already registered and approved; rotate its token from the admin panel instead',
          'already_registered',
        );
      }
      const issued = issueToken();
      await existing.update({
        ...attributes,
        tokenHash: issued.tokenHash,
        tokenPrefix: issued.tokenPrefix,
        tokenIssuedAt: new Date(),
        registeredAt: new Date(),
      });
      return this.describe(existing, issued.token, 'Registration refreshed, waiting for approval');
    }

    const issued = issueToken();
    const autoApprove = this.isAutoApproveEnabled();
    const worker = await AgentWorker.create({
      ...attributes,
      instanceId,
      kind: 'external' as AgentWorkerKind,
      status: autoApprove ? 'active' : 'pending',
      tokenHash: issued.tokenHash,
      tokenPrefix: issued.tokenPrefix,
      tokenIssuedAt: new Date(),
      registeredAt: new Date(),
      approvedAt: autoApprove ? new Date() : null,
      approvedBy: autoApprove ? 'AGENTIZ_WORKER_AUTO_APPROVE' : null,
      allowedProjectIds: null,
    });
    console.log(`[AgentizWorkerRegistry] worker "${name}" (${instanceId}) registered as ${worker.status}`);
    return this.describe(
      worker,
      issued.token,
      autoApprove ? 'Worker registered and auto-approved' : 'Worker registered, waiting for an administrator to approve it',
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
    if (worker.status === 'pending') {
      throw new WorkerRegistryError(403, 'Worker is awaiting approval', 'pending_approval');
    }
    if (worker.status !== 'active') {
      throw new WorkerRegistryError(403, `Worker is ${worker.status}`, 'not_active');
    }
    return worker;
  }

  static describe(worker: AgentWorker, token?: string, message = ''): RegisterWorkerResult {
    return {
      schemaVersion: SCHEMA_VERSION,
      workerId: worker.id,
      status: worker.status,
      ...(token ? { token } : {}),
      tokenPrefix: worker.tokenPrefix,
      approved: worker.status === 'active',
      allowedProjectIds: worker.allowedProjectIds ?? null,
      message,
    };
  }

  // --- admin operations -------------------------------------------------------------------

  static async list(): Promise<AgentWorker[]> {
    return AgentWorker.findAll({ order: [['createdAt', 'DESC']] });
  }

  static async approve(workerId: string, approvedBy: string, allowedProjectIds?: string[] | null): Promise<AgentWorker> {
    const worker = await this.require(workerId);
    if (worker.status === 'revoked') throw new WorkerRegistryError(409, 'Revoked worker cannot be approved', 'revoked');
    await worker.update({
      status: 'active',
      approvedAt: new Date(),
      approvedBy,
      revokedReason: null,
      ...(allowedProjectIds === undefined ? {} : { allowedProjectIds: allowedProjectIds?.length ? allowedProjectIds : null }),
    });
    console.log(`[AgentizWorkerRegistry] worker ${worker.name} approved by ${approvedBy}`);
    return worker;
  }

  static async disable(workerId: string, reason?: string | null): Promise<AgentWorker> {
    const worker = await this.require(workerId);
    await worker.update({ status: 'disabled', revokedReason: reason ?? null });
    await this.releaseActiveJobs(worker, reason ?? 'worker disabled');
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

  /** Issues a new personal token; the previous one stops working immediately. */
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
        approvedAt: new Date(),
        approvedBy: 'system (in-process worker)',
        allowedProjectIds: null,
      },
    });
    await worker.update({ lastSeenAt: new Date(), ...(worker.status === 'pending' ? { status: 'active' } : {}) });
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
