import { getWorkflowEngine, WorkflowAdminApi } from '@nodeknit/app-workflow';
import type { WorkflowEngine } from '@nodeknit/app-workflow';

/**
 * The one place app-agentiz reaches *into* the running engine, rather than contributing data to it.
 *
 * Everything else in `lib/workflow/` travels through collections and type-only imports, which is
 * what keeps this layer independent of whether the engine app is enabled. These two things cannot:
 * completing a node that waits for a pipeline is a call, and so is every MCP tool. Both stay
 * tolerant of an engine that is not there — `getWorkflowEngine()` reads a `Symbol.for` holder that
 * is empty until `AppWorkflow.mount()` runs, and is empty again after it unmounts.
 */
export function workflowEngine(): WorkflowEngine | undefined {
  return getWorkflowEngine();
}

/** For the MCP tools: they have a person on the other end, so an absent engine is an error. */
export function workflowAdminApi(): WorkflowAdminApi {
  const engine = workflowEngine();
  if (!engine) {
    throw new Error('Workflow engine is not running (is app-workflow enabled?)');
  }
  return new WorkflowAdminApi(engine);
}

/** The external ref an `agentiz.pipeline` node parks on. Both halves spell it here, once. */
export function pipelineRunRef(runId: string): string {
  return `run:${runId}`;
}

/**
 * Continue whatever flow was waiting for this pipeline run.
 *
 * Best-effort by construction: it is called from an `AgentRun` model hook, and a workflow that
 * cannot be continued is never a reason to fail writing the run's own terminal status. An unknown
 * ref (no flow waited for this run — the usual case) is not an error and the engine only logs it.
 */
export async function completePipelineWait(
  runId: string,
  outcome: {
    status: string;
    summary?: string | null;
    error?: string | null;
    taskId?: string;
    projectId?: string;
    /**
     * Machine-readable pass/fail off a verdict stage's own output (see lib/runVerdict.ts). Present
     * only for a pipeline that asked for one — absent is the pre-existing shape, and keeps routing
     * on `succeeded`/`failed` exactly as before this field existed.
     */
    verdict?: 'pass' | 'fail' | null;
  },
): Promise<void> {
  const engine = workflowEngine();
  if (!engine) return;
  try {
    await engine.completeExternal(pipelineRunRef(runId), {
      // Not `error:` even for a failed pipeline: a failure is a *result* the graph routes on its
      // own port, not a broken workflow. Only an engine-level problem should fail the flow.
      //
      // A pipeline that asked for a verdict and actually finished routes on `pass`/`fail` instead
      // of `succeeded` — the agent's opinion, not the infra outcome. `failed` stays reserved
      // strictly for the agent never having produced a result at all (crash, cancellation): the
      // agent's own "test failed" belongs on the `fail` port, never on `failed`. See nodeDocs on
      // `agentiz.pipeline` (nodes.ts).
      output: outcome.status === 'succeeded' ? (outcome.verdict ?? 'succeeded') : 'failed',
      msg: {
        payload: {
          runId,
          taskId: outcome.taskId,
          projectId: outcome.projectId,
          status: outcome.status,
          summary: outcome.summary ?? null,
          error: outcome.error ?? null,
          verdict: outcome.verdict ?? null,
        },
      },
    });
  } catch (error) {
    console.error(`[AppAgentiz] failed to continue the workflow waiting for run ${runId}:`, error);
  }
}
