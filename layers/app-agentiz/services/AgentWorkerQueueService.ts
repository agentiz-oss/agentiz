import { Op } from 'sequelize';
import { AgentRun } from '../models/AgentRun';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentStageExecution } from '../models/AgentStageExecution';
import { AgentTask } from '../models/AgentTask';
import type { AgentWorker } from '../models/AgentWorker';
import { AgentJobClaimService } from './AgentJobClaimService';
import { AgentRunDeferService } from './AgentRunDeferService';
import { AgentPipelineService } from './AgentPipelineService';
import { AgentWorkerApiService } from './AgentWorkerApiService';
import { AgentWorkerRegistryService } from './AgentWorkerRegistryService';

const POLL_INTERVAL_MS = Number(process.env.AGENTIZ_LOCAL_WORKER_POLL_MS ?? 3000);
/** Stable instance id so a restart reuses the same AgentWorker row instead of piling up records. */
const LOCAL_INSTANCE_ID = process.env.AGENTIZ_LOCAL_WORKER_ID ?? 'agentiz-local';

export class AgentWorkerQueueService {
  private static timer: NodeJS.Timeout | null = null;
  private static running = false;
  private static worker: AgentWorker | null = null;

  static isEnabled(): boolean {
    if (process.env.AGENTIZ_LOCAL_WORKER_ENABLED === 'true') return true;
    if (process.env.AGENTIZ_LOCAL_WORKER_ENABLED === 'false') return false;
    return !AgentWorkerApiService.isEnabled();
  }

  static start(): void {
    if (!this.isEnabled()) {
      console.log('[AgentizWorkerQueue] local worker disabled');
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.drainOnce().catch((error) => {
        console.error('[AgentizWorkerQueue] drain failed:', error);
      });
    }, Math.max(POLL_INTERVAL_MS, 1000));
    void this.drainOnce().catch((error) => {
      console.error('[AgentizWorkerQueue] initial drain failed:', error);
    });
    console.log(`[AgentizWorkerQueue] local worker enabled as ${LOCAL_INSTANCE_ID}`);
  }

  static stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  static async drainOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const worker = await this.identity();
      // The in-process worker obeys the same gate as remote ones: disable it in the admin panel
      // and it stops receiving jobs.
      if (worker.status !== 'active') return;
      const job = await this.claimLocalJob(worker);
      if (!job) return;
      await this.executeLocalJob(worker, job);
    } finally {
      this.running = false;
    }
  }

  /** The local worker is a registered AgentWorker too, so the admin list shows every executor. */
  private static async identity(): Promise<AgentWorker> {
    if (!this.worker) {
      this.worker = await AgentWorkerRegistryService.ensureLocalWorker(LOCAL_INSTANCE_ID, `Local worker (${LOCAL_INSTANCE_ID})`);
    } else {
      await this.worker.reload();
    }
    return this.worker;
  }

  private static async claimLocalJob(worker: AgentWorker): Promise<AgentRunJob | null> {
    // Same filters as the remote claim, from the shared service. Workspace Git actions are
    // implemented by the external worker that owns the checkout, hence pipelineOnly.
    const { job } = await AgentJobClaimService.claim(worker, {
      mode: 'local',
      lockMs: 60 * 60 * 1000,
      pipelineOnly: true,
    });
    return job;
  }

  private static async executeLocalJob(worker: AgentWorker, job: AgentRunJob): Promise<void> {
    await AgentWorkerRegistryService.noteClaim(worker);
    await AgentPipelineService.log(job.runId, job.projectId, null, 'info', `Local worker picked job ${job.id}`, {
      workerId: worker.id,
      attempt: job.attempt,
    });
    try {
      const run = await AgentPipelineService.executeRun(job.runId);
      // The in-process worker gets the same limit handling as remote ones: a failure that
      // classifies as a harness limit defers the job instead of terminalizing the run.
      if (run.status === 'failed' && run.errorMessage) {
        const completedStages = await AgentStageExecution.findAll({
          where: { runId: run.id, status: { [Op.in]: ['succeeded', 'skipped'] } },
          attributes: ['id'],
        });
        const classified = await AgentRunDeferService.classify(job, worker, run.errorMessage, completedStages.map((stage) => stage.id));
        if (classified) {
          // executeRun already marked the run failed; take that back — the run is waiting, not dead.
          await run.update({ status: 'pending', finishedAt: null });
          await AgentTask.update({ status: 'queued' }, { where: { id: run.taskId } });
          await AgentRunDeferService.defer({ job, run, worker, classified, errorText: run.errorMessage });
          return;
        }
      }
      const terminalStatus = run.status === 'succeeded' ? 'succeeded' : run.status === 'cancelled' ? 'cancelled' : 'failed';
      await job.update({
        status: terminalStatus,
        result: {
          executor: 'local',
          runStatus: run.status,
          summary: run.resultSummary,
          commitSha: run.commitSha,
          responseUrl: run.responseUrl,
        },
        lockedUntil: null,
        lastError: run.errorMessage,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await job.update({ status: 'failed', lockedUntil: null, lastError: message });
      const run = await AgentRun.findByPk(job.runId);
      if (run && run.status !== 'succeeded' && run.status !== 'failed' && run.status !== 'cancelled') {
        await run.update({ status: 'failed', finishedAt: new Date(), errorMessage: message });
      }
      await AgentPipelineService.log(job.runId, job.projectId, null, 'error', `Local worker failed: ${message}`);
    }
  }
}
