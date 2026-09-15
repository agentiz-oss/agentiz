import type { ExternalRef, WorkflowRunRecord, WorkflowRunStore } from '@nodeknit/app-workflow';
import { AgentTask } from '../../models/AgentTask';
import { AgentWorkflowRun } from '../../models/AgentWorkflowRun';
import { ApprovalService } from '../../services/ApprovalService';

/**
 * The engine's run state, on a table (`workflowStores` collection).
 *
 * What this buys is the `waiting_external` case: `agentiz.pipeline` parks a flow for as long as a
 * pipeline runs, and with the engine's in-memory default a restart in that window would leave the
 * flow neither finished nor waiting — and the finished pipeline would find nothing to continue.
 *
 * Written on every node transition, so it stays a plain row-per-run with the trace in JSON; the
 * engine already decides *what* to persist and when.
 *
 * It is also the **one** place every workflow-run transition passes through, which is why two
 * pieces of Agentiz bookkeeping live here rather than in the nodes: which task a run belongs to
 * (lifted out of `msg.payload` into a column), and which flow currently owns a task
 * (`AgentTask.currentWorkflowRunId`). Putting either in a node would mean a graph that forgets to
 * use that node silently loses the invariant.
 */
export class AgentizWorkflowRunStore implements WorkflowRunStore {
  /**
   * Which runs this process is walking **right now** — see `walksInFlight()`.
   *
   * Per instance rather than global: a store is the state of one engine, and an engine that was
   * thrown away must not go on answering for the one that replaced it.
   */
  private readonly walking = new Set<string>();

  /**
   * How many graph walks this process has in flight.
   *
   * The engine walks a graph **detached** — `start()` hands the walk to `void this.advance(...)` so
   * that a trigger's `fire()` does not wait for the whole flow — and the walk is therefore
   * unnameable from the outside, exactly like the detached work in `lib/detachedWork.ts`. This
   * store is the one place that sees every transition of it (that is already why the task
   * bookkeeping lives here), so it is also the only place that can say whether the walk is still
   * going: a run enters `running` when it starts and leaves it when it parks, finishes or fails.
   *
   * Counted around the whole store call, not just the write, because the terminal call is where
   * the task is released and the approvals are cancelled — work that is part of the walk.
   */
  walksInFlight(): number {
    return this.walking.size;
  }

  async create(run: WorkflowRunRecord): Promise<void> {
    return this.walk(run, async () => {
      await AgentWorkflowRun.create(toRow(run));
      await claimTask(run);
    });
  }

  async update(run: WorkflowRunRecord): Promise<void> {
    return this.walk(run, async () => {
      // upsert, not update: a store installed mid-flight (or a run created before it arrived) would
      // otherwise silently write nothing and the run would be invisible to `completeExternal`.
      await AgentWorkflowRun.upsert(toRow(run));
      // Only the terminal transition touches Agentiz's own bookkeeping. Doing it on *every*
      // transition would be both wasteful — the store is written on each node — and wrong: the
      // `agentiz.task.comment` node deliberately releases the task before writing the remark that
      // starts the next round, and a per-transition sync would immediately claim it back.
      if (!isTerminalWorkflowStatus(run.status)) return;
      await releaseTask(run);
      await releaseApprovals(run);
    });
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

  /**
   * Write one transition, holding the walk open across it.
   *
   * The mark is taken **before** the write and dropped **after** the whole call, which is what
   * makes the bracket seamless: the engine calls `create()` and then reaches its first `get()`
   * without yielding to the event loop, so there is no instant in which a walk that is running
   * looks finished.
   */
  private async walk(run: WorkflowRunRecord, write: () => Promise<void>): Promise<void> {
    if (run.status === 'running') this.walking.add(run.id);
    try {
      await write();
    } catch (error) {
      // A transition that could not be written is the end of the walk as far as anybody watching is
      // concerned: the engine has nothing left to continue from.
      this.walking.delete(run.id);
      throw error;
    }
    if (run.status !== 'running') this.walking.delete(run.id);
  }
}

/** The engine's own vocabulary for "nobody is waiting on this run any more". */
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

export function isTerminalWorkflowStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** The task a run is about, as the trigger put it into `msg.payload`; absent for a non-task flow. */
function taskIdOf(run: WorkflowRunRecord): string | null {
  const payload = (run.msg as { payload?: Record<string, unknown> } | undefined)?.payload;
  const taskId = payload && typeof payload === 'object' ? payload.taskId : null;
  return typeof taskId === 'string' && taskId.length > 0 ? taskId : null;
}

function projectIdOf(run: WorkflowRunRecord): string | null {
  const payload = (run.msg as { payload?: Record<string, unknown> } | undefined)?.payload;
  const projectId = payload && typeof payload === 'object' ? payload.projectId : null;
  return typeof projectId === 'string' && projectId.length > 0 ? projectId : null;
}

/**
 * "У задачи один хозяин", claimed: a starting flow marks the task as driven by it.
 *
 * Written with a `where` rather than read-then-write so two flows racing for one task cannot both
 * see an empty field and both claim it — the loser's UPDATE matches no row.
 *
 * A bulk `AgentTask.update(..., { where })` skips the model's instance hooks, and here that is the
 * point rather than the usual caveat: `currentWorkflowRunId` is not one of the fields
 * `agentiz.task.updated` watches, and a flow claiming a task must not look like somebody editing
 * it.
 */
async function claimTask(run: WorkflowRunRecord): Promise<void> {
  const taskId = taskIdOf(run);
  if (!taskId) return;
  try {
    await AgentTask.update(
      { currentWorkflowRunId: run.id },
      { where: { id: taskId, currentWorkflowRunId: null } },
    );
  } catch (error) {
    // A workflow's bookkeeping must never be the reason the engine's own state fails to persist.
    console.error(`[AppAgentiz] failed to claim task ${taskId} for workflow run ${run.id}:`, error);
  }
}

/**
 * …and released. Only the claim this run holds itself: a flow that ends after a newer one already
 * took the task over must not clear the newer one's id.
 */
async function releaseTask(run: WorkflowRunRecord): Promise<void> {
  const taskId = taskIdOf(run);
  if (!taskId) return;
  try {
    await AgentTask.update(
      { currentWorkflowRunId: null },
      { where: { id: taskId, currentWorkflowRunId: run.id } },
    );
  } catch (error) {
    console.error(`[AppAgentiz] failed to release task ${taskId} of workflow run ${run.id}:`, error);
  }
}

/**
 * A flow that ended stops holding people: its still-`pending` approval requests are cancelled.
 *
 * The engine has no `ExternalNodeExecutor.cancel?(ref)` yet, so the cheaper half of the plan's
 * §7.6 is done here — at the one place that sees every workflow-run transition. An approval that
 * was actually decided is already out of `pending` by the time this runs, so a normal flow ends
 * with nothing to cancel.
 */
async function releaseApprovals(run: WorkflowRunRecord): Promise<void> {
  if (!isTerminalWorkflowStatus(run.status)) return;
  try {
    const cancelled = await ApprovalService.cancelForWorkflowRun(run.id);
    if (cancelled > 0) {
      console.warn(`[AppAgentiz] workflow run ${run.id} ended as "${run.status}", ${cancelled} approval request(s) cancelled`);
    }
  } catch (error) {
    console.error(`[AppAgentiz] failed to cancel approvals of workflow run ${run.id}:`, error);
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
    projectId: projectIdOf(run),
    taskId: taskIdOf(run),
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
