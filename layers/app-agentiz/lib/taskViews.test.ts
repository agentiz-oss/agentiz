import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_VIEW,
  TASK_VIEWS,
  taskView,
  taskViewCount,
  taskViewStatuses,
} from './taskViews';

/**
 * The board's tabs. Pure functions, no database — what is pinned here is the agreement between the
 * two readers: the server queries by `taskViewStatuses`, the browser writes `taskViewCount` beside
 * the same tab, and a disagreement between them is a caption that counts six tasks over a list of
 * four.
 */
describe('task views', () => {
  it('falls back to the default tab for anything it does not know', () => {
    expect(taskView(null).key).toBe(DEFAULT_TASK_VIEW);
    expect(taskView('').key).toBe(DEFAULT_TASK_VIEW);
    // A hand-edited address, or a tab that has since been renamed: the board must still render.
    expect(taskView('нет такой').key).toBe(DEFAULT_TASK_VIEW);
  });

  it('narrows nothing for «Все», so the filter is absent rather than empty', () => {
    // `undefined`, never `[]`: an empty array reads as "no status matches" and would show an empty
    // board for the one tab that is supposed to show everything.
    expect(taskViewStatuses('all')).toBeUndefined();
    expect(taskViewStatuses('open')).toContain('new');
  });

  it('files a failed task under «Открытые» and not under «Готовые»', () => {
    // The work is not done, and a board that hides a failure among finished tasks is how it goes
    // unnoticed for a day.
    expect(taskViewStatuses('open')).toContain('failed');
    expect(taskViewStatuses('done')).toEqual(['done']);
  });

  it('counts a tab by summing exactly the statuses it queries by', () => {
    const counts = { new: 2, running: 1, waiting_input: 3, done: 4, cancelled: 5 };
    const of = (key: string) => taskViewCount(taskView(key), counts);

    expect(of('open')).toBe(2 + 1 + 3);
    expect(of('running')).toBe(1);
    expect(of('waiting')).toBe(3);
    expect(of('done')).toBe(4);
    // «Все» sums whatever the server sent, including statuses no tab covers — otherwise a task in
    // `cancelled` would be invisible on every tab and the totals would not add up.
    expect(of('all')).toBe(15);
  });

  it('counts an absent status as zero rather than failing', () => {
    // The server sends only the statuses that occur, so most keys are missing most of the time.
    expect(taskViewCount(taskView('open'), {})).toBe(0);
    expect(TASK_VIEWS.every((view) => taskViewCount(view, { done: 1 }) >= 0)).toBe(true);
  });
});
