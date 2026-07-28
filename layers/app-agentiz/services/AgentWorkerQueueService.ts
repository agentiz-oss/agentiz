import { Op } from 'sequelize';
import { AgentRun } from '../models/AgentRun';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentPipelineService } from './AgentPipelineService';
import { AgentWorkerApiService } from './AgentWorkerApiService';

const POLL_INTERVAL_MS = Number(process.env.AGENTIZ_LOCAL_WORKER_POLL_MS ?? 3000);
const LOCAL_WORKER_ID = process.env.AGENTIZ_LOCAL_WORKER_ID ?? `agentiz-local-${process.pid}`;

export class AgentWorkerQueueService {
  private static timer: NodeJS.Timeout | null = null;
  private static running = false;

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
    console.log(`[AgentizWorkerQueue] local worker enabled as ${LOCAL_WORKER_ID}`);
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
      const job = await this.claimLocalJob();
      if (!job) return;
      await this.executeLocalJob(job);
    } finally {
      this.running = false;
    }
  }

  private static async claimLocalJob(): Promise<AgentRunJob | null> {
    const sequelize = AgentRunJob.sequelize;
    if (!sequelize) throw new Error('Sequelize is not initialized');
    return sequelize.transaction(async (transaction) => {
      const job = await AgentRunJob.findOne({
        where: {
          status: 'queued',
          availableAt: { [Op.lte]: new Date() },
        },
        order: [['priority', 'ASC'], ['createdAt', 'ASC']],
        transaction,
        lock: transaction.LOCK.UPDATE,
        skipLocked: true,
      });
      if (!job) return null;
      await job.update({
        status: 'running',
        workerId: LOCAL_WORKER_ID,
        attempt: job.attempt + 1,
        lockedUntil: new Date(Date.now() + 60 * 60 * 1000),
        lastError: null,
      }, { transaction });
      return job;
    });
  }

  private static async executeLocalJob(job: AgentRunJob): Promise<void> {
    await AgentPipelineService.log(job.runId, null, 'info', `Local worker picked job ${job.id}`, {
      workerId: LOCAL_WORKER_ID,
      attempt: job.attempt,
    });
    try {
      const run = await AgentPipelineService.executeRun(job.runId);
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
      await AgentPipelineService.log(job.runId, null, 'error', `Local worker failed: ${message}`);
    }
  }
}
