import { createHash, randomUUID } from 'crypto';
import { Op } from 'sequelize';
import { AgentProject } from '../models/AgentProject';
import { AgentRun } from '../models/AgentRun';
import { AgentRunEventDedup } from '../models/AgentRunEventDedup';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentRunLog } from '../models/AgentRunLog';
import { AgentRunResultDedup } from '../models/AgentRunResultDedup';
import { AgentStageExecution } from '../models/AgentStageExecution';
import { AgentTask } from '../models/AgentTask';
import type { AgentRunLogLevel, AgentTaskStatus } from '../types/agentiz';
import type { FileChange } from '../lib/git';
import { AgentPipelineService } from './AgentPipelineService';

const SCHEMA_VERSION = 1;
const DEFAULT_LEASE_MS = 60_000;

type WorkerEvent = {
  eventId: string;
  sequence: number;
  type: string;
  timestamp?: string;
  stageExecutionId?: string | null;
  level?: AgentRunLogLevel;
  message?: string;
  meta?: Record<string, unknown>;
};

type WorkerResult = {
  schemaVersion: number;
  workerId: string;
  attempt: number;
  leaseToken: string;
  resultId: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  summary?: string;
  errorMessage?: string;
  fileChanges?: FileChange[];
  stageOutputs?: Array<{
    executionId: string;
    status: 'succeeded' | 'failed' | 'skipped';
    summary?: string;
    output?: Record<string, unknown>;
    errorMessage?: string;
  }>;
};

export class WorkerApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function datePlus(ms: number): Date {
  return new Date(Date.now() + ms);
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new WorkerApiError(400, 'JSON object body is required');
  }
  return body as Record<string, unknown>;
}

export class AgentWorkerApiService {
  static isEnabled(): boolean {
    return process.env.AGENTIZ_WORKER_API_ENABLED === 'true';
  }

  static assertEnabledAndAuthorized(authHeader: string): void {
    if (!this.isEnabled()) throw new WorkerApiError(503, 'Agentiz Worker API is disabled');
    const token = process.env.AGENTIZ_WORKER_TOKEN;
    if (!token) throw new WorkerApiError(503, 'AGENTIZ_WORKER_TOKEN is not configured');
    if (authHeader !== `Bearer ${token}`) throw new WorkerApiError(401, 'Invalid worker token');
  }

  static async claim(body: unknown, authHeader: string): Promise<Record<string, unknown> | null> {
    this.assertEnabledAndAuthorized(authHeader);
    const payload = objectBody(body);
    if (payload.schemaVersion !== SCHEMA_VERSION) throw new WorkerApiError(400, 'Unsupported schemaVersion');
    const workerId = typeof payload.workerId === 'string' && payload.workerId ? payload.workerId : null;
    if (!workerId) throw new WorkerApiError(400, 'workerId is required');

    const sequelize = AgentRunJob.sequelize;
    if (!sequelize) throw new WorkerApiError(500, 'Sequelize is not initialized');
    const leaseToken = randomUUID();
    const lockedUntil = datePlus(DEFAULT_LEASE_MS);

    const job = await sequelize.transaction(async (transaction) => {
      const candidate = await AgentRunJob.findOne({
        where: {
          status: 'queued',
          availableAt: { [Op.lte]: new Date() },
        },
        order: [['priority', 'ASC'], ['createdAt', 'ASC']],
        transaction,
        lock: transaction.LOCK.UPDATE,
        skipLocked: true,
      });
      if (!candidate) return null;
      await candidate.update({
        status: 'leased',
        workerId,
        attempt: candidate.attempt + 1,
        leaseTokenHash: hashToken(leaseToken),
        lockedUntil,
        lastError: null,
      }, { transaction });
      return candidate;
    });

    if (!job) return null;
    await this.markRunStarted(job);
    await AgentPipelineService.log(job.runId, null, 'info', `Worker job claimed by ${workerId}`, { jobId: job.id, attempt: job.attempt });
    return {
      schemaVersion: SCHEMA_VERSION,
      jobId: job.id,
      runId: job.runId,
      attempt: job.attempt,
      leaseToken,
      leaseExpiresAt: lockedUntil.toISOString(),
      cancelRequested: Boolean(job.cancelRequestedAt),
      ...job.snapshot,
    };
  }

  static async heartbeat(jobId: string, body: unknown, authHeader: string): Promise<Record<string, unknown>> {
    this.assertEnabledAndAuthorized(authHeader);
    const payload = objectBody(body);
    const job = await this.requireLeasedJob(jobId, payload);
    const lockedUntil = datePlus(DEFAULT_LEASE_MS);
    await job.update({ status: 'running', lockedUntil });
    return {
      schemaVersion: SCHEMA_VERSION,
      command: job.cancelRequestedAt ? 'cancel' : 'continue',
      reason: job.cancelReason,
      leaseExpiresAt: lockedUntil.toISOString(),
    };
  }

  static async recordEvents(jobId: string, body: unknown, authHeader: string): Promise<Record<string, unknown>> {
    this.assertEnabledAndAuthorized(authHeader);
    const payload = objectBody(body);
    const job = await this.requireLeasedJob(jobId, payload);
    const events = Array.isArray(payload.events) ? payload.events as WorkerEvent[] : [];
    let accepted = 0;
    let lastAcceptedSequence = 0;
    for (const event of events) {
      if (!event?.eventId || !Number.isFinite(event.sequence) || !event.type) continue;
      const [dedup, created] = await AgentRunEventDedup.findOrCreate({
        where: { jobId: job.id, attempt: job.attempt, eventId: event.eventId },
        defaults: { jobId: job.id, runId: job.runId, attempt: job.attempt, eventId: event.eventId, sequence: event.sequence },
      });
      lastAcceptedSequence = Math.max(lastAcceptedSequence, dedup.sequence);
      if (!created) continue;
      accepted += 1;
      await this.applyEvent(job, event);
      lastAcceptedSequence = Math.max(lastAcceptedSequence, event.sequence);
    }
    return { schemaVersion: SCHEMA_VERSION, accepted, lastAcceptedSequence };
  }

  static async applyResult(jobId: string, body: unknown, authHeader: string): Promise<Record<string, unknown>> {
    this.assertEnabledAndAuthorized(authHeader);
    const payload = objectBody(body) as WorkerResult;
    const job = await this.requireLeasedJob(jobId, payload);
    if (!payload.resultId) throw new WorkerApiError(400, 'resultId is required');
    const [dedup, created] = await AgentRunResultDedup.findOrCreate({
      where: { jobId: job.id, attempt: job.attempt, resultId: payload.resultId },
      defaults: { jobId: job.id, runId: job.runId, attempt: job.attempt, resultId: payload.resultId },
    });
    if (!created) {
      const run = await AgentRun.findByPk(job.runId);
      return { schemaVersion: SCHEMA_VERSION, deduplicated: true, terminalRunStatus: run?.status ?? null, resultDedupId: dedup.id };
    }

    const run = await AgentRun.findByPk(job.runId);
    const [task, project] = run ? await Promise.all([AgentTask.findByPk(run.taskId), AgentProject.findByPk(run.projectId)]) : [null, null];
    if (!run || !task || !project) throw new WorkerApiError(404, 'Run, task or project not found');

    for (const stage of payload.stageOutputs ?? []) {
      await AgentStageExecution.update({
        status: stage.status,
        output: stage.output ?? (stage.summary ? { summary: stage.summary } : null),
        errorMessage: stage.errorMessage ?? null,
        finishedAt: new Date(),
      }, { where: { id: stage.executionId, runId: run.id } });
    }

    const summary = payload.summary ?? '';
    if (payload.status === 'succeeded') {
      try {
        await AgentPipelineService.applyFinalAction({
          run,
          task,
          project,
          changes: payload.fileChanges ?? [],
          summary,
        });
        await run.update({ status: 'succeeded', finishedAt: new Date(), resultSummary: summary || null, errorMessage: null });
        const finalTaskStatus: AgentTaskStatus = run.pipelineSnapshot.finalAction.type === 'commit_and_pr' ? 'waiting_review' : 'done';
        await task.update({ status: finalTaskStatus });
        await job.update({ status: 'succeeded', result: payload as unknown as Record<string, unknown>, lockedUntil: null });
        await AgentPipelineService.log(run.id, null, 'info', `Worker job succeeded, task moved to "${finalTaskStatus}"`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await run.update({ status: 'failed', finishedAt: new Date(), resultSummary: summary || null, errorMessage: message });
        await task.update({ status: 'failed' });
        await job.update({ status: 'failed', result: payload as unknown as Record<string, unknown>, lastError: message, lockedUntil: null });
        await AgentPipelineService.log(run.id, null, 'error', `Final action failed: ${message}`);
      }
    } else {
      const terminal = payload.status === 'cancelled' ? 'cancelled' : 'failed';
      const taskStatus: AgentTaskStatus = terminal === 'cancelled' ? 'cancelled' : 'failed';
      await run.update({ status: terminal, finishedAt: new Date(), resultSummary: summary || null, errorMessage: payload.errorMessage ?? null });
      await task.update({ status: taskStatus });
      await job.update({ status: terminal, result: payload as unknown as Record<string, unknown>, lastError: payload.errorMessage ?? null, lockedUntil: null });
      await AgentPipelineService.log(run.id, null, terminal === 'cancelled' ? 'warn' : 'error', `Worker job ${terminal}: ${payload.errorMessage ?? summary}`);
    }

    return { schemaVersion: SCHEMA_VERSION, deduplicated: false, terminalRunStatus: (await AgentRun.findByPk(job.runId))?.status ?? null };
  }

  static async release(jobId: string, body: unknown, authHeader: string): Promise<Record<string, unknown>> {
    this.assertEnabledAndAuthorized(authHeader);
    const payload = objectBody(body);
    const job = await this.requireLeasedJob(jobId, payload);
    const message = typeof payload.errorMessage === 'string' ? payload.errorMessage : null;
    await job.update({
      status: 'released',
      workerId: null,
      leaseTokenHash: null,
      lockedUntil: null,
      availableAt: datePlus(30_000),
      lastError: message,
    });
    await AgentPipelineService.log(job.runId, null, 'warn', `Worker released job${message ? `: ${message}` : ''}`);
    return { schemaVersion: SCHEMA_VERSION, released: true, retryAt: job.availableAt };
  }

  private static async requireLeasedJob(jobId: string, payload: Record<string, unknown>): Promise<AgentRunJob> {
    if (payload.schemaVersion !== SCHEMA_VERSION) throw new WorkerApiError(400, 'Unsupported schemaVersion');
    const workerId = typeof payload.workerId === 'string' && payload.workerId ? payload.workerId : null;
    const leaseToken = typeof payload.leaseToken === 'string' && payload.leaseToken ? payload.leaseToken : null;
    const attempt = typeof payload.attempt === 'number' ? payload.attempt : null;
    if (!workerId || !leaseToken || !attempt) throw new WorkerApiError(400, 'workerId, attempt and leaseToken are required');
    const job = await AgentRunJob.findByPk(jobId);
    if (!job) throw new WorkerApiError(404, 'Job not found');
    if (job.workerId !== workerId || job.attempt !== attempt || job.leaseTokenHash !== hashToken(leaseToken)) {
      throw new WorkerApiError(409, 'Lease does not belong to this worker');
    }
    if (job.lockedUntil && job.lockedUntil.getTime() < Date.now()) {
      throw new WorkerApiError(409, 'Lease expired');
    }
    if (job.status !== 'leased' && job.status !== 'running') {
      throw new WorkerApiError(409, `Job is ${job.status}`);
    }
    return job;
  }

  private static async markRunStarted(job: AgentRunJob): Promise<void> {
    const run = await AgentRun.findByPk(job.runId);
    if (!run) throw new WorkerApiError(404, 'Run not found');
    if (run.status === 'pending') {
      await run.update({ status: 'running', startedAt: new Date() });
      await AgentTask.update({ status: 'running' }, { where: { id: run.taskId } });
    }
  }

  private static async applyEvent(job: AgentRunJob, event: WorkerEvent): Promise<void> {
    const level = event.level ?? (event.type.includes('failed') ? 'error' : 'info');
    await AgentRunLog.create({
      runId: job.runId,
      stageExecutionId: event.stageExecutionId ?? null,
      level,
      message: event.message ?? event.type,
      meta: { ...(event.meta ?? {}), eventId: event.eventId, sequence: event.sequence, type: event.type },
    });

    if (event.stageExecutionId && event.type === 'stage.started') {
      await AgentStageExecution.update({ status: 'running', startedAt: new Date() }, { where: { id: event.stageExecutionId, runId: job.runId } });
    }
    if (event.stageExecutionId && event.type === 'stage.completed') {
      await AgentStageExecution.update({ status: 'succeeded', finishedAt: new Date() }, { where: { id: event.stageExecutionId, runId: job.runId } });
    }
    if (event.stageExecutionId && event.type === 'stage.failed') {
      await AgentStageExecution.update({ status: 'failed', errorMessage: event.message ?? null, finishedAt: new Date() }, { where: { id: event.stageExecutionId, runId: job.runId } });
    }
  }
}
