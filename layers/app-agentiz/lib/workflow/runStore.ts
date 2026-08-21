import type { ExternalRef, WorkflowRunRecord, WorkflowRunStore } from '@nodeknit/app-workflow';
import { AgentWorkflowRun } from '../../models/AgentWorkflowRun';

/**
 * The engine's run state, on a table (`workflowStores` collection).
 *
 * What this buys is the `waiting_external` case: `agentiz.pipeline` parks a flow for as long as a
 * pipeline runs, and with the engine's in-memory default a restart in that window would leave the
 * flow neither finished nor waiting — and the finished pipeline would find nothing to continue.
 *
 * Written on every node transition, so it stays a plain row-per-run with the trace in JSON; the
 * engine already decides *what* to persist and when.
 */
export class AgentizWorkflowRunStore implements WorkflowRunStore {
  async create(run: WorkflowRunRecord): Promise<void> {
    await AgentWorkflowRun.create(toRow(run));
  }

  async update(run: WorkflowRunRecord): Promise<void> {
    // upsert, not update: a store installed mid-flight (or a run created before it arrived) would
    // otherwise silently write nothing and the run would be invisible to `completeExternal`.
    await AgentWorkflowRun.upsert(toRow(run));
  }

  async get(runId: string): Promise<WorkflowRunRecord | null> {
    const row = await AgentWorkflowRun.findByPk(runId);
    return row ? toRecord(row) : null;
  }

  async listActive(): Promise<WorkflowRunRecord[]> {
    const rows = await AgentWorkflowRun.findAll({
      where: { status: ['running', 'waiting_external', 'deferred'] },
      order: [['startedAt', 'ASC']],
    });
    return rows.map(toRecord);
  }

  async findByExternalRef(ref: ExternalRef): Promise<WorkflowRunRecord | null> {
    const row = await AgentWorkflowRun.findOne({ where: { externalRef: ref } });
    return row ? toRecord(row) : null;
  }

  async listBySpec(specId: string, limit: number): Promise<WorkflowRunRecord[]> {
    const rows = await AgentWorkflowRun.findAll({
      where: { specId },
      order: [['startedAt', 'DESC']],
      limit,
    });
    return rows.map(toRecord);
  }
}

function toRow(run: WorkflowRunRecord): Record<string, unknown> {
  return {
    id: run.id,
    specId: run.specId,
    providerId: run.providerId,
    specVersion: run.specVersion ?? null,
    status: run.status,
    trigger: run.trigger,
    msg: (run.msg ?? {}) as Record<string, unknown>,
    currentNodeId: run.currentNodeId ?? null,
    externalRef: run.externalRef ?? null,
    waitingUntil: run.waitingUntil ?? null,
    waitingReason: run.waitingReason ?? null,
    error: run.error ?? null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    nodeRuns: (run.nodeRuns ?? []) as unknown as Array<Record<string, unknown>>,
  };
}

function toRecord(row: AgentWorkflowRun): WorkflowRunRecord {
  return {
    id: row.id,
    specId: row.specId,
    providerId: row.providerId,
    specVersion: row.specVersion ?? undefined,
    status: row.status as WorkflowRunRecord['status'],
    trigger: row.trigger,
    msg: (row.msg ?? {}) as WorkflowRunRecord['msg'],
    currentNodeId: row.currentNodeId ?? undefined,
    externalRef: row.externalRef ?? undefined,
    // Dates come back as strings from the JSON dialects' DATE columns in some drivers; the engine
    // does arithmetic on `waitingUntil`, so it must be a Date whatever sqlite/postgres handed back.
    waitingUntil: row.waitingUntil ? new Date(row.waitingUntil) : undefined,
    waitingReason: row.waitingReason ?? undefined,
    error: row.error ?? undefined,
    startedAt: new Date(row.startedAt),
    finishedAt: row.finishedAt ? new Date(row.finishedAt) : undefined,
    nodeRuns: (row.nodeRuns ?? []) as unknown as WorkflowRunRecord['nodeRuns'],
  };
}
