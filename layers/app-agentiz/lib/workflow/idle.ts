import { detachedWorkPending } from '../detachedWork';
import type { AgentizWorkflowRunStore } from './runStore';

/**
 * "Is this process doing anything on behalf of a workflow right now?"
 *
 * A flow runs in two detached halves and neither half is awaited by whoever caused it: the trigger
 * decides out of band (`lib/workflow/nodes.ts`, registered in `lib/detachedWork.ts`), and the
 * engine walks the graph out of band (`WorkflowEngine.start` hands it to `void this.advance(...)`,
 * observed through `AgentizWorkflowRunStore.walksInFlight()`). Each half is exact, and together
 * they leave no gap, because every handoff happens *inside* the other half: the trigger's tracked
 * promise only settles after `runStore.create()` has marked the walk, and a walk only raises the
 * next trigger from inside a node, while its own mark is still held.
 *
 * Hence this barrier, instead of the `setTimeout(250)` that stood here before it. A duration is a
 * bet on machine load: it was lost under a full test run, where a flow arrived after the assertion
 * meant to cover it, and its leftovers landed in the next test's freshly dropped schema — three
 * kinds of failure (a missing launch, a launch too many, an unhandled `no such table`) with one
 * cause. A barrier cannot be lost; it can only take longer.
 *
 * The deadline is not a timeout to tune: it exists so that a flow that genuinely never finishes
 * fails loudly here, with its counters, instead of turning back into a flake somewhere downstream.
 */
export async function workflowIdle(
  store: AgentizWorkflowRunStore,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (detachedWorkPending() === 0 && store.walksInFlight() === 0) {
      // One turn of the event loop before believing it: a promise that resolved in this very tick
      // has its bookkeeping in a microtask, and a walk that just ended may still be inside the
      // model hook that starts the next round.
      await new Promise((resolve) => setImmediate(resolve));
      if (detachedWorkPending() === 0 && store.walksInFlight() === 0) return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `workflow work did not settle in ${timeoutMs}ms`
        + ` (detached: ${detachedWorkPending()}, walks: ${store.walksInFlight()})`,
      );
    }
    // A **timer**, and never a promise that may already be resolved: the walking half is a set
    // nobody resolves a promise for, so this loop has to poll it — and a poll that only awaits
    // microtasks starves the event loop it is waiting for. (That is not theory: written as
    // `Promise.race([detachedWorkSettled(), …])`, this loop spun on microtasks whenever nothing
    // was registered and sqlite's I/O callbacks never got a turn, so the walk it was waiting for
    // could not make progress and every single test hit the deadline.)
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
