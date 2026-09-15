/**
 * The task board's tabs, and the only place that knows which statuses each of them means.
 *
 * A tab is **not** one stored status — «Ждут человека» is two of them and «Открытые» is six — so it
 * cannot be expressed by the plain `status` filter the list endpoint already has. Both halves read
 * this table: the server turns `view` into the `statuses` it queries by, the browser module draws
 * the tabs and sums `statusCounts` into the number beside each one. Written out once because the
 * two answers have to agree — a tab whose caption counts six tasks and whose list shows four is
 * exactly the kind of thing nobody reports and everybody stops trusting.
 *
 * Deliberately free of imports, `process` and `window`, like `routeTree.ts`: Vite bundles it into
 * the browser module and tsx runs the same source on the server.
 */

export interface TaskView {
  /** The value in `?view=`; `open` is the default and is written as an absent parameter. */
  key: string;
  label: string;
  /** The stored statuses this tab shows, or `null` for «Все» — which filters nothing at all. */
  statuses: readonly string[] | null;
}

/**
 * Order is the order of the tabs. `failed` lives under «Открытые» on purpose: a run that fell over
 * left the work undone, and a board that files it under «Готовые» is how a failure goes unnoticed.
 */
export const TASK_VIEWS: readonly TaskView[] = [
  { key: 'open', label: 'Открытые', statuses: ['new', 'queued', 'running', 'waiting_input', 'waiting_review', 'failed'] },
  { key: 'running', label: 'В работе', statuses: ['queued', 'running'] },
  { key: 'waiting', label: 'Ждут человека', statuses: ['waiting_input', 'waiting_review'] },
  { key: 'done', label: 'Готовые', statuses: ['done'] },
  { key: 'all', label: 'Все', statuses: null },
] as const;

export const DEFAULT_TASK_VIEW = 'open';

/** The tab a `?view=` value names, falling back to the default for anything unknown. */
export function taskView(key: string | null | undefined): TaskView {
  return TASK_VIEWS.find((view) => view.key === key) ?? TASK_VIEWS[0];
}

/**
 * The statuses a view narrows to, or `undefined` when it narrows nothing.
 *
 * `undefined` rather than an empty array, because that is what the list filter reads as "no status
 * condition" — an empty array would mean "nothing matches" and show an empty board for «Все».
 */
export function taskViewStatuses(key: string | null | undefined): string[] | undefined {
  const statuses = taskView(key).statuses;
  return statuses ? [...statuses] : undefined;
}

/** How many tasks a tab holds, given `statusCounts` from the list endpoint. */
export function taskViewCount(view: TaskView, counts: Record<string, number>): number {
  const statuses = view.statuses ?? Object.keys(counts);
  return statuses.reduce((sum, status) => sum + (counts[status] ?? 0), 0);
}
