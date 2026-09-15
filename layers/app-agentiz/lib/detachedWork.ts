/**
 * The work this layer deliberately does **after** its caller has gone.
 *
 * A few places here start something and return immediately, and each is right to: a workflow
 * trigger decides out of band because the emit that raised it is synchronous inside a model hook's
 * transaction, and a repository's webhook reconciles after the commit that linked it, because a
 * platform that is slow or down must not fail the write. Detaching is the decision; this module is
 * its price, paid once.
 *
 * What detaching costs is that the work becomes **unnameable**. Nothing in the process can tell
 * "the trigger decided not to run" apart from "the trigger has not decided yet", so there is no
 * moment at which it is safe to stop the process, close the database, or assert that something did
 * not happen. A duration is not that moment either — `setTimeout(250)` is a bet on how loaded the
 * machine is, and the bet is lost exactly when six test workers share six cores: the work lands
 * after the assertion that was supposed to cover it, or after the schema it writes to is gone.
 *
 * So detached work registers here and becomes awaitable again. `detachedWorkSettled()` is what a
 * shutdown — or a test that has to prove an absence — waits for. Registering is one call at the
 * site that detaches; forgetting to make that call is the only way to fall back out of it, which is
 * why there are deliberately few such sites (`lib/workflow/nodes.ts`,
 * `lib/webhooks/repositoryWebhook.ts`).
 *
 * Note what this is **not**: it neither catches nor delays anything. The promise is handed back as
 * it was and the work runs exactly when it did before. One caveat that is not optional — observing
 * a promise means attaching a handler to it, so a registered promise counts as handled and its
 * failure would be silent. Every site here keeps its own `.catch`, and a new one must too.
 */

/** Same tsx double-instantiation hazard as every other registry here — hence the global symbol. */
const PENDING_KEY = Symbol.for('agentiz.detachedWork');

function pending(): Set<Promise<unknown>> {
  const holder = globalThis as unknown as Record<symbol, Set<Promise<unknown>> | undefined>;
  if (!holder[PENDING_KEY]) holder[PENDING_KEY] = new Set();
  return holder[PENDING_KEY]!;
}

/**
 * Register a promise as work that outlives its caller, and hand it straight back.
 *
 * Registration is synchronous with the call, which is what makes the barrier below exact: work
 * started from inside other tracked work (a trigger that fires a flow, a flow that writes a comment
 * that raises a trigger) is registered before the work that started it is allowed to settle.
 */
export function trackDetachedWork<T>(work: Promise<T>): Promise<T> {
  const set = pending();
  set.add(work);
  // `finally` on a copy: the caller's own chain is untouched, and a rejection stays a rejection for
  // whoever attached a handler to the promise that was passed in.
  void work.then(
    () => { set.delete(work); },
    () => { set.delete(work); },
  );
  return work;
}

/** How much detached work this process is carrying right now. Synchronous on purpose. */
export function detachedWorkPending(): number {
  return pending().size;
}

/**
 * Resolve once nothing is in flight, including work that the work in flight starts in its turn.
 *
 * Never rejects: a detached failure is the caller's business (every site logs its own), and a
 * barrier that threw on somebody else's error would be a new way to fail a shutdown.
 */
export async function detachedWorkSettled(): Promise<void> {
  const set = pending();
  while (set.size > 0) {
    await Promise.allSettled([...set]);
  }
}
