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
import { AgentGitConnection } from '../models/AgentGitConnection';
import { AgentRepository } from '../models/AgentRepository';
import type { AgentRunLogLevel, AgentTaskStatus } from '../types/agentiz';
import type { FileChange, FileOp } from '../lib/git';
import { normalizeFileChanges, requireGitConnectionAuthority } from '../lib/git';
import { AgentRunDiff } from '../models/AgentRunDiff';
import { AgentPipelineService } from './AgentPipelineService';
import { AgentWorkerRegistryService } from './AgentWorkerRegistryService';
import type { AgentWorker } from '../models/AgentWorker';
import { AgentRunInteractionService, InteractionError } from './AgentRunInteractionService';
import { AgentWorkspaceProposal } from '../models/AgentWorkspaceProposal';
import { AgentWorkspaceProposalService } from './AgentWorkspaceProposalService';

const SCHEMA_VERSION = 1;
const DEFAULT_LEASE_MS = 60_000;

/**
 * Username each platform expects in a token-authenticated HTTPS clone. The password is the OAuth
 * access token in both cases; only the username differs.
 */
const CLONE_USERNAME: Record<string, string> = {
  gitlab: 'oauth2',
  github: 'x-access-token',
};

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
  attempt: number;
  leaseToken: string;
  resultId: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  summary?: string;
  errorMessage?: string;
  /** Legacy shape; `fileOps` is the current one. Both are accepted. */
  fileChanges?: FileChange[];
  fileOps?: FileOp[];
  /** Raw `git diff` of the worker's tree against `baseSha`, stored as-is. */
  patch?: string;
  /** Lossless transport for binary/invalid-UTF8 unified patches. */
  patchBase64?: string;
  patchTruncated?: boolean;
  patchSizeBytes?: number;
  patchSha256?: string;
  treeSha?: string;
  baseSha?: string;
  git?: {
    baseBranch?: string;
    remote?: string;
    remoteUrl?: string;
    remoteBaseSha?: string;
  };
  commitSha?: string;
  targetBranch?: string;
  workspaceUntouched?: boolean;
  diffStats?: { files?: number; insertions?: number; deletions?: number };
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

function renderCommitMessage(template: string, run: AgentRun, task: AgentTask, summary: string): string {
  const values: Record<string, string> = {
    taskId: task.id, externalId: task.externalId, title: task.title, summary,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => values[key] ?? '');
}

export class AgentWorkerApiService {
  static isEnabled(): boolean {
    return process.env.AGENTIZ_WORKER_API_ENABLED !== 'false';
  }

   /**
    * Every job endpoint runs as an active worker identity: there is no shared token any more, the
    * bearer is the personal token an admin issued when creating the worker in the panel.
    */
  static async authorize(authHeader: string | undefined, ip?: string | null): Promise<AgentWorker> {
    if (!this.isEnabled()) throw new WorkerApiError(503, 'Agentiz Worker API is disabled');
    return AgentWorkerRegistryService.authenticateActive(authHeader, ip);
  }

  static async claim(body: unknown, authHeader: string, ip?: string | null): Promise<Record<string, unknown> | null> {
    const worker = await this.authorize(authHeader, ip);
    const payload = objectBody(body);
    if (payload.schemaVersion !== SCHEMA_VERSION) throw new WorkerApiError(400, 'Unsupported schemaVersion');

    const sequelize = AgentRunJob.sequelize;
    if (!sequelize) throw new WorkerApiError(500, 'Sequelize is not initialized');
    const workerId = worker.id;
    const leaseToken = randomUUID();
    const lockedUntil = datePlus(DEFAULT_LEASE_MS);
    // The allowlist is enforced in the claim query itself: a worker cannot even see a snapshot of
    // a project it was not granted.
    const allowedProjectIds = worker.allowedProjectIds?.length ? worker.allowedProjectIds : null;
    // Second axis of the same rule: a worker must not even see the snapshot of a repository it was
    // not granted — it carries task text, prompts and repository coordinates.
    const allowedRepositoryIds = worker.allowedRepositoryIds?.length ? worker.allowedRepositoryIds : null;

    const job = await sequelize.transaction(async (transaction) => {
      const candidate = await AgentRunJob.findOne({
        where: {
          status: 'queued',
          availableAt: { [Op.lte]: new Date() },
          ...(allowedProjectIds ? { projectId: { [Op.in]: allowedProjectIds } } : {}),
          // A job with no repository (finalAction: none) is never restricted, or a worker with a
          // narrow allowlist could not run a pipeline that never touches git.
          ...(allowedRepositoryIds
            ? { [Op.and]: [{ [Op.or]: [{ repositoryId: null }, { repositoryId: { [Op.in]: allowedRepositoryIds } }] }] }
            : {}),
          ...(worker.capabilities?.workspaceGit === true ? {} : { jobKind: 'pipeline' }),
          // A job pinned to a worker directory belongs to that machine alone; everyone else must
          // not even see it, or it would be claimed and then fail for a missing path.
          [Op.or]: [{ requiredWorkerId: null }, { requiredWorkerId: workerId }],
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
    await AgentWorkerRegistryService.noteClaim(worker);
    await this.markRunStarted(job);
    if (job.proposalId && job.jobKind !== 'pipeline') {
      await AgentWorkspaceProposal.update({
        status: job.jobKind === 'workspace_commit_push' ? 'applying' : 'resetting',
      }, { where: { id: job.proposalId } });
    }
    await AgentPipelineService.log(job.runId, job.projectId, null, 'info', `Worker job claimed by ${worker.name}`, {
      jobId: job.id,
      attempt: job.attempt,
      workerId,
    });
    return {
      schemaVersion: SCHEMA_VERSION,
      jobId: job.id,
      runId: job.runId,
      workerId,
      attempt: job.attempt,
      leaseToken,
      leaseExpiresAt: lockedUntil.toISOString(),
      cancelRequested: Boolean(job.cancelRequestedAt),
      jobKind: job.jobKind,
      ...job.snapshot,
    };
  }

  static async heartbeat(jobId: string, body: unknown, authHeader: string, ip?: string | null): Promise<Record<string, unknown>> {
    const worker = await this.authorize(authHeader, ip);
    const payload = objectBody(body);
    const job = await this.requireLeasedJob(jobId, payload, worker);
    const lockedUntil = datePlus(DEFAULT_LEASE_MS);
    await job.update({ status: 'running', lockedUntil });
    return {
      schemaVersion: SCHEMA_VERSION,
      command: job.cancelRequestedAt ? 'cancel' : 'continue',
      reason: job.cancelReason,
      leaseExpiresAt: lockedUntil.toISOString(),
    };
  }

  static async recordEvents(jobId: string, body: unknown, authHeader: string, ip?: string | null): Promise<Record<string, unknown>> {
    const worker = await this.authorize(authHeader, ip);
    const payload = objectBody(body);
    const job = await this.requireLeasedJob(jobId, payload, worker);
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

  static async applyResult(jobId: string, body: unknown, authHeader: string, ip?: string | null): Promise<Record<string, unknown>> {
    const worker = await this.authorize(authHeader, ip);
    const payload = objectBody(body) as WorkerResult;
    const job = await this.requireLeasedJob(jobId, payload as unknown as Record<string, unknown>, worker);
    if (!payload.resultId) throw new WorkerApiError(400, 'resultId is required');
    if (job.jobKind === 'pipeline' && payload.status === 'succeeded' && await AgentRunInteractionService.hasUnresolved(job)) {
      throw new WorkerApiError(409, 'Successful result is not allowed while human input is unresolved');
    }
    const [dedup, created] = await AgentRunResultDedup.findOrCreate({
      where: { jobId: job.id, attempt: job.attempt, resultId: payload.resultId },
      defaults: { jobId: job.id, runId: job.runId, attempt: job.attempt, resultId: payload.resultId },
    });
    if (!created) {
      const run = await AgentRun.findByPk(job.runId);
      return { schemaVersion: SCHEMA_VERSION, deduplicated: true, terminalRunStatus: run?.status ?? null, resultDedupId: dedup.id };
    }

    if (job.jobKind !== 'pipeline') {
      return this.applyWorkspaceActionResult(job, payload);
    }

    if (payload.status !== 'succeeded') {
      await AgentRunInteractionService.closeForJob(job, 'cancelled', payload.errorMessage ?? payload.status);
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
    if (job.proposalId) {
      return this.applyWorkspacePipelineResult(job, run, task, payload, summary);
    }
    if (payload.status === 'succeeded') {
      // Written before anything is pushed, and that ordering is the requirement: a failed push used
      // to take the agent's entire work product with it.
      const ops = normalizeFileChanges(payload.fileOps ?? payload.fileChanges);
      const diff = await this.storeRunDiff(job, run, ops, payload);
      try {
        await AgentPipelineService.applyFinalAction({
          run,
          task,
          project,
          changes: ops,
          summary,
          diff,
        });
        await run.update({ status: 'succeeded', finishedAt: new Date(), resultSummary: summary || null, errorMessage: null });
        const finalTaskStatus: AgentTaskStatus = AgentPipelineService.taskStatusAfter(run.pipelineSnapshot.finalAction);
        await AgentRunInteractionService.setTaskStatusConsideringActiveRuns(task.id, finalTaskStatus);
        await job.update({ status: 'succeeded', result: payload as unknown as Record<string, unknown>, lockedUntil: null });
        await AgentPipelineService.log(run.id, run.projectId, null, 'info', `Worker job succeeded, task moved to "${finalTaskStatus}"`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await run.update({ status: 'failed', finishedAt: new Date(), resultSummary: summary || null, errorMessage: message });
        await AgentRunInteractionService.setTaskStatusConsideringActiveRuns(task.id, 'failed');
        await job.update({ status: 'failed', result: payload as unknown as Record<string, unknown>, lastError: message, lockedUntil: null });
        await AgentPipelineService.log(run.id, run.projectId, null, 'error', `Final action failed: ${message}`);
      }
    } else {
      const terminal = payload.status === 'cancelled' ? 'cancelled' : 'failed';
      const taskStatus: AgentTaskStatus = terminal === 'cancelled' ? 'cancelled' : 'failed';
      await run.update({ status: terminal, finishedAt: new Date(), resultSummary: summary || null, errorMessage: payload.errorMessage ?? null });
      await AgentRunInteractionService.setTaskStatusConsideringActiveRuns(task.id, taskStatus);
      await job.update({ status: terminal, result: payload as unknown as Record<string, unknown>, lastError: payload.errorMessage ?? null, lockedUntil: null });
      await AgentPipelineService.log(run.id, run.projectId, null, terminal === 'cancelled' ? 'warn' : 'error', `Worker job ${terminal}: ${payload.errorMessage ?? summary}`);
      // A failure is what a person most needs to see in the task thread, so it reports too.
      await AgentPipelineService.reportToTaskThread(
        run,
        task,
        payload.errorMessage ? `Запуск ${terminal}: ${payload.errorMessage}` : summary || `Запуск ${terminal}`,
      );
    }

    return { schemaVersion: SCHEMA_VERSION, deduplicated: false, terminalRunStatus: (await AgentRun.findByPk(job.runId))?.status ?? null };
  }

  /**
   * Stores what the agent changed. Called for every successful result, before the final action, so
   * the diff survives whatever happens next — including a push that fails.
   *
   * The patch is cut at AGENTIZ_MAX_PATCH_BYTES rather than dropped: a truncated patch still shows
   * what was going on, and the operations, which are what actually gets applied, are kept whole.
   */
  private static async storeRunDiff(
    job: AgentRunJob,
    run: AgentRun,
    ops: FileOp[],
    payload: WorkerResult,
  ): Promise<AgentRunDiff | null> {
    if (ops.length === 0 && !payload.patch && !payload.patchBase64 && !job.proposalId) return null;

    const limit = Number(process.env.AGENTIZ_MAX_PATCH_BYTES ?? 5 * 1024 * 1024);
    const rawBytes = payload.patchBase64 ? Buffer.from(payload.patchBase64, 'base64') : Buffer.from(payload.patch ?? '', 'utf8');
    const actualSize = rawBytes.length;
    const computedHash = createHash('sha256').update(rawBytes).digest('hex');
    if (payload.patchSha256 && !payload.patchTruncated && payload.patchSha256 !== computedHash) {
      throw new WorkerApiError(400, 'patchSha256 does not match the uploaded patch');
    }
    const truncated = Boolean(payload.patchTruncated) || actualSize > limit
      || (payload.patchSizeBytes !== undefined && payload.patchSizeBytes !== actualSize);
    const patch = (truncated ? rawBytes.subarray(0, limit) : rawBytes).toString('utf8');

    const [diff] = await AgentRunDiff.upsert({
      runId: run.id,
      projectId: run.projectId,
      repositoryId: job.repositoryId,
      baseSha: payload.baseSha ?? run.baseSha ?? null,
      proposalId: job.proposalId,
      revision: run.workspaceRevision,
      treeSha: payload.treeSha ?? null,
      patchSizeBytes: payload.patchSizeBytes ?? actualSize,
      patchSha256: payload.patchSha256 ?? computedHash,
      patch: patch || null,
      ops,
      stats: {
        files: payload.diffStats?.files ?? ops.length,
        insertions: payload.diffStats?.insertions ?? 0,
        deletions: payload.diffStats?.deletions ?? 0,
      },
      truncated,
      appliedAt: null,
      appliedCommitSha: null,
    });
    await AgentPipelineService.log(run.id, run.projectId, null, 'info', `Stored run diff: ${ops.length} operation(s)`, {
      diffId: diff.id,
      truncated,
    });
    return diff;
  }

  private static async applyWorkspacePipelineResult(
    job: AgentRunJob,
    run: AgentRun,
    task: AgentTask,
    payload: WorkerResult,
    summary: string,
  ): Promise<Record<string, unknown>> {
    const proposal = await AgentWorkspaceProposal.findByPk(job.proposalId!);
    if (!proposal || proposal.latestRunId !== run.id || proposal.revision !== run.workspaceRevision) {
      throw new WorkerApiError(409, 'Worker result is not for the latest proposal revision');
    }
    const ops = normalizeFileChanges(payload.fileOps ?? payload.fileChanges);
    // A failed worker may still leave a useful patch for a human to inspect and recover.  Do not
    // put an otherwise empty failed run into the review queue, though: there is nothing to review
    // and it hides the actual failure on the task.
    const hasReviewableChanges = ops.length > 0
      || Boolean(payload.patch)
      || Boolean(payload.patchBase64);
    let diff: AgentRunDiff | null = null;
    if (payload.workspaceUntouched) {
      await proposal.update({ status: 'rejected', rejectedAt: new Date(), reservationKey: null, lastError: payload.errorMessage ?? 'Git preflight failed' });
      const terminal = payload.status === 'cancelled' ? 'cancelled' : 'failed';
      await run.update({ status: terminal, finishedAt: new Date(), resultSummary: summary || null, errorMessage: payload.errorMessage ?? null });
      await job.update({ status: terminal, result: payload as unknown as Record<string, unknown>, lastError: payload.errorMessage ?? null, lockedUntil: null });
      await task.update({ status: terminal });
      return { schemaVersion: SCHEMA_VERSION, deduplicated: false, terminalRunStatus: terminal, proposalStatus: 'rejected' };
    }
    if (payload.status !== 'succeeded' && !hasReviewableChanges) {
      await proposal.update({
        status: 'rejected',
        rejectedAt: new Date(),
        reservationKey: null,
        lastError: payload.errorMessage ?? `Workspace run ${payload.status} without changes to review`,
      });
      await run.update({ status: payload.status, finishedAt: new Date(), resultSummary: summary || null, errorMessage: payload.errorMessage ?? null });
      await job.update({ status: payload.status, result: payload as unknown as Record<string, unknown>, lastError: payload.errorMessage ?? null, lockedUntil: null });
      await AgentRunInteractionService.setTaskStatusConsideringActiveRuns(task.id, payload.status);
      await AgentPipelineService.reportToTaskThread(
        run,
        task,
        payload.errorMessage ? `Запуск ${payload.status}: ${payload.errorMessage}` : summary || `Запуск ${payload.status}`,
      );
      return { schemaVersion: SCHEMA_VERSION, deduplicated: false, terminalRunStatus: payload.status, proposalStatus: 'rejected' };
    }
    try {
      diff = await this.storeRunDiff(job, run, ops, payload);
      if (!diff || !payload.treeSha || !payload.baseSha || !payload.git?.baseBranch || !payload.git.remoteUrl) {
        throw new Error('Workspace Git result is missing a complete diff or preflight metadata');
      }
      await proposal.update({
        latestDiffId: diff.id,
        baseSha: proposal.baseSha ?? payload.baseSha,
        baseBranch: proposal.baseBranch ?? payload.git.baseBranch,
        remote: payload.git.remote ?? proposal.remote,
        remoteUrl: proposal.remoteUrl ?? payload.git.remoteUrl,
        remoteBaseSha: proposal.remoteBaseSha ?? payload.git.remoteBaseSha ?? null,
        expectedTreeSha: payload.treeSha,
        status: 'waiting_review',
        lastError: diff.truncated ? 'Full patch was not stored; approval is blocked' : payload.errorMessage ?? null,
        commitMessage: renderCommitMessage(
          run.pipelineSnapshot.finalAction.commitMessageTemplate ?? '{{title}}\n\n{{summary}}', run, task, summary,
        ),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await proposal.update({ status: 'waiting_review', lastError: message });
    }

    const runTerminal = payload.status;
    await run.update({ status: runTerminal, finishedAt: new Date(), resultSummary: summary || null, errorMessage: payload.errorMessage ?? null,
      baseSha: proposal.baseSha, baseRef: proposal.baseBranch });
    await job.update({ status: runTerminal, result: payload as unknown as Record<string, unknown>, lastError: payload.errorMessage ?? null, lockedUntil: null });
    await task.update({ status: 'waiting_review' });
    await AgentPipelineService.reportToTaskThread(run, task,
      payload.errorMessage ? `Запуск ${runTerminal}: ${payload.errorMessage}` : summary || `Workspace revision ${proposal.revision} готова к проверке`);

    if (payload.status === 'succeeded' && ops.length > 0 && diff && !diff.truncated
      && run.pipelineSnapshot.finalAction.requireApproval !== true) {
      await AgentWorkspaceProposalService.approve(proposal.id, proposal.revision, 'system:auto');
    }
    return { schemaVersion: SCHEMA_VERSION, deduplicated: false, terminalRunStatus: runTerminal, proposalStatus: (await proposal.reload()).status };
  }

  private static async applyWorkspaceActionResult(job: AgentRunJob, payload: WorkerResult): Promise<Record<string, unknown>> {
    const proposal = job.proposalId ? await AgentWorkspaceProposal.findByPk(job.proposalId) : null;
    if (!proposal) throw new WorkerApiError(404, 'Workspace proposal not found');
    const queuedRevision = Number((job.snapshot.proposal as { revision?: number } | undefined)?.revision);
    if (queuedRevision !== proposal.revision) {
      throw new WorkerApiError(409, `Action job revision ${queuedRevision} is stale; proposal is ${proposal.revision}`);
    }
    const expectedKind = job.jobKind === 'workspace_commit_push' ? 'apply_queued' : 'reset_queued';
    const activeKind = job.jobKind === 'workspace_commit_push' ? 'applying' : 'resetting';
    if (![expectedKind, activeKind].includes(proposal.status)) {
      throw new WorkerApiError(409, `Proposal is ${proposal.status}, not awaiting ${job.jobKind}`);
    }
    if (payload.status === 'succeeded') {
      if (job.jobKind === 'workspace_commit_push') {
        if (!payload.commitSha) throw new WorkerApiError(400, 'commitSha is required for a successful push');
        await proposal.update({ status: 'pushed', pushedCommitSha: payload.commitSha, pushedAt: new Date(), reservationKey: null, lastError: null });
        await AgentRun.update({ commitSha: payload.commitSha }, { where: { id: proposal.latestRunId } });
        await AgentRunDiff.update({ appliedAt: new Date(), appliedCommitSha: payload.commitSha }, { where: { id: proposal.latestDiffId } });
        await AgentTask.update({ status: 'done' }, { where: { id: proposal.taskId } });
      } else {
        await proposal.update({ status: 'rejected', rejectedAt: new Date(), reservationKey: null, lastError: null });
        await AgentTask.update({ status: 'cancelled' }, { where: { id: proposal.taskId } });
      }
      await job.update({ status: 'succeeded', result: payload as unknown as Record<string, unknown>, lockedUntil: null, lastError: null });
    } else {
      const message = payload.errorMessage ?? payload.summary ?? `${job.jobKind} failed`;
      await proposal.update({ status: job.jobKind === 'workspace_commit_push' ? 'push_failed' : 'reset_failed', lastError: message });
      await job.update({ status: payload.status === 'cancelled' ? 'cancelled' : 'failed', result: payload as unknown as Record<string, unknown>, lockedUntil: null, lastError: message });
      await AgentTask.update({ status: 'waiting_review' }, { where: { id: proposal.taskId } });
    }
    return { schemaVersion: SCHEMA_VERSION, deduplicated: false, terminalRunStatus: null, proposalStatus: (await proposal.reload()).status };
  }

  /**
   * Short-lived repository credentials for the job the caller currently holds.
   *
   * A separate endpoint rather than a field in `AgentRunJob.snapshot` on purpose: the snapshot is
   * persisted forever, handed out in full on every claim including retries, and ends up in dumps
   * and in the admin panel. A token cannot live there.
   *
   * The clone URL is returned clean, with username and password beside it, so the worker can feed
   * them through GIT_ASKPASS and they never settle in `.git/config`.
   */
  static async issueSecrets(jobId: string, body: unknown, authHeader: string, ip?: string | null): Promise<Record<string, unknown>> {
    const worker = await this.authorize(authHeader, ip);
    const payload = objectBody(body);
    // Same gate as heartbeat/result: the lease must be current, and the worker id comes from the
    // authenticated identity rather than from the request body.
    const job = await this.requireLeasedJob(jobId, payload, worker);

    // Second line of defence behind the claim filter: even if a job somehow reached the wrong
    // worker, it does not get the credentials.
    if (!worker.canClaimRepository(job.repositoryId)) {
      throw new WorkerApiError(403, 'This worker is not allowed to access the job repository');
    }

    if (!job.repositoryId) {
      // A pipeline that never touches git (finalAction: none, or a worker-directory source) has
      // nothing to hand out. Not an error — the worker asks unconditionally.
      return { schemaVersion: SCHEMA_VERSION, repository: null };
    }

    const repository = await AgentRepository.findByPk(job.repositoryId);
    if (!repository) throw new WorkerApiError(404, 'Job repository no longer exists');
    const connection = await AgentGitConnection.findByPk(repository.connectionId);
    if (!connection) throw new WorkerApiError(404, 'Repository connection no longer exists');

    const authority = requireGitConnectionAuthority(repository.provider);
    // Refreshes the token transparently when it is about to expire.
    const token = await authority.accessToken(connection);

    await AgentPipelineService.log(job.runId, job.projectId, null, 'info', `Issued repository credentials to ${worker.name}`, {
      jobId: job.id,
      workerId: worker.id,
      repositoryId: repository.id,
      // Deliberately no token, no username: this line is an audit record, not a copy of the secret.
    });

    return {
      schemaVersion: SCHEMA_VERSION,
      repository: {
        repositoryId: repository.id,
        provider: repository.provider,
        cloneUrl: repository.cloneUrl,
        username: CLONE_USERNAME[repository.provider],
        password: token,
        expiresAt: connection.expiresAt?.toISOString() ?? null,
      },
    };
  }

  static async release(jobId: string, body: unknown, authHeader: string, ip?: string | null): Promise<Record<string, unknown>> {
    const worker = await this.authorize(authHeader, ip);
    const payload = objectBody(body);
    const job = await this.requireLeasedJob(jobId, payload, worker);
    const message = typeof payload.errorMessage === 'string' ? payload.errorMessage : null;
    await AgentRunInteractionService.closeForJob(job, 'orphaned', message ?? 'job released');
    // `released` is a parking state, not a terminal one: AgentJobReaperService flips it back to
    // `queued` once availableAt passes, which is what makes the retryAt below a real promise.
    await job.update({
      status: 'released',
      workerId: null,
      leaseTokenHash: null,
      lockedUntil: null,
      availableAt: datePlus(30_000),
      lastError: message,
    });
    await AgentPipelineService.log(job.runId, job.projectId, null, 'warn', `Worker released job${message ? `: ${message}` : ''}`);
    return { schemaVersion: SCHEMA_VERSION, released: true, retryAt: job.availableAt };
  }

  static async createInteraction(jobId: string, body: unknown, authHeader: string, ip?: string | null): Promise<Record<string, unknown>> {
    const worker = await this.authorize(authHeader, ip);
    const payload = objectBody(body);
    const job = await this.requireLeasedJob(jobId, payload, worker);
    try {
      const interaction = await AgentRunInteractionService.create(job, {
        externalRequestId: typeof payload.externalRequestId === 'string' ? payload.externalRequestId : '',
        stageExecutionId: typeof payload.stageExecutionId === 'string' ? payload.stageExecutionId : '',
        source: typeof payload.source === 'string' ? payload.source : 'acp',
        message: typeof payload.message === 'string' ? payload.message : '',
        requestedSchema: payload.requestedSchema as Record<string, unknown>,
        toolCallId: typeof payload.toolCallId === 'string' ? payload.toolCallId : null,
        meta: payload.meta && typeof payload.meta === 'object' && !Array.isArray(payload.meta)
          ? payload.meta as Record<string, unknown>
          : null,
        timeoutSec: typeof payload.timeoutSec === 'number' ? payload.timeoutSec : undefined,
      });
      return { schemaVersion: SCHEMA_VERSION, interaction: interaction.toJSON() };
    } catch (error) {
      if (error instanceof InteractionError) throw new WorkerApiError(error.status, error.message);
      throw error;
    }
  }

  static async waitInteraction(
    jobId: string,
    interactionId: string,
    body: unknown,
    authHeader: string,
    ip?: string | null,
  ): Promise<Record<string, unknown> | null> {
    const worker = await this.authorize(authHeader, ip);
    const payload = objectBody(body);
    const job = await this.requireLeasedJob(jobId, payload, worker);
    try {
      const interaction = await AgentRunInteractionService.wait(
        job,
        interactionId,
        typeof payload.waitMs === 'number' ? payload.waitMs : 25_000,
      );
      if (!interaction) return null;
      const action = interaction.responseAction
        ?? (['cancelled', 'expired', 'orphaned'].includes(interaction.status) ? 'cancel' : null);
      return {
        schemaVersion: SCHEMA_VERSION,
        interactionId: interaction.id,
        status: interaction.status,
        response: action ? { action, content: action === 'accept' ? interaction.responseContent : null } : null,
      };
    } catch (error) {
      if (error instanceof InteractionError) throw new WorkerApiError(error.status, error.message);
      throw error;
    }
  }

  static async acknowledgeInteraction(
    jobId: string,
    interactionId: string,
    body: unknown,
    authHeader: string,
    ip?: string | null,
  ): Promise<Record<string, unknown>> {
    const worker = await this.authorize(authHeader, ip);
    const payload = objectBody(body);
    const job = await this.requireLeasedJob(jobId, payload, worker);
    try {
      const interaction = await AgentRunInteractionService.acknowledge(job, interactionId);
      return { schemaVersion: SCHEMA_VERSION, interaction: interaction.toJSON() };
    } catch (error) {
      if (error instanceof InteractionError) throw new WorkerApiError(error.status, error.message);
      throw error;
    }
  }

  private static async requireLeasedJob(jobId: string, payload: Record<string, unknown>, worker: AgentWorker): Promise<AgentRunJob> {
    if (payload.schemaVersion !== SCHEMA_VERSION) throw new WorkerApiError(400, 'Unsupported schemaVersion');
    const leaseToken = typeof payload.leaseToken === 'string' && payload.leaseToken ? payload.leaseToken : null;
    const attempt = typeof payload.attempt === 'number' ? payload.attempt : null;
    if (!leaseToken || !attempt) throw new WorkerApiError(400, 'attempt and leaseToken are required');
    const job = await AgentRunJob.findByPk(jobId);
    if (!job) throw new WorkerApiError(404, 'Job not found');
    // The worker id comes from the authenticated identity, never from the request body.
    if (job.workerId !== worker.id || job.attempt !== attempt || job.leaseTokenHash !== hashToken(leaseToken)) {
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
    if (job.jobKind !== 'pipeline') return;
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
      projectId: job.projectId,
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
