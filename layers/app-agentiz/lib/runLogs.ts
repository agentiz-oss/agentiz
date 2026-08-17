import { Op } from 'sequelize';
import { AgentRunLog } from '../models/AgentRunLog';

/**
 * The one way anything reads a run's log.
 *
 * Every reader used to take the *first* N rows (`ASC` + `limit`). That is the wrong end: while an
 * agent is working the interesting line is the newest one, and once a run streams its tool calls a
 * long run passes any fixed N — after which new lines silently stop appearing, freezing the screen
 * on exactly the run somebody is watching. So a page without a cursor is the **tail**, and the
 * beginning is fetched deliberately, with `before`.
 *
 * The sort key is `(createdAt, id)`, not `createdAt` alone: several lines share a millisecond, and
 * a cursor on a non-unique key either repeats or skips them.
 */

export interface RunLogPage {
  logs: AgentRunLog[];
  /** Newest line in the page. Poll with `after` set to this; null when the page is empty. */
  nextCursor: string | null;
  /** Oldest line in the page. Load what precedes it with `before` set to this. */
  earlierCursor: string | null;
  /** Something exists before this page (tail/`before` reads only). */
  hasEarlier: boolean;
  /** The `after` page was cut by `limit` — ask again now instead of waiting for the next tick. */
  hasMore: boolean;
}

export interface RunLogQuery {
  after?: string | null;
  before?: string | null;
  limit?: number;
}

export const DEFAULT_RUN_LOG_LIMIT = 200;
export const MAX_RUN_LOG_LIMIT = 1_000;

const EMPTY_PAGE: RunLogPage = { logs: [], nextCursor: null, earlierCursor: null, hasEarlier: false, hasMore: false };

export function runLogCursor(log: AgentRunLog): string {
  return `${new Date(log.createdAt).toISOString()}|${log.id}`;
}

function parseCursor(raw: string | null | undefined, field: string): { createdAt: Date; id: string } | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const separator = raw.indexOf('|');
  const createdAt = new Date(separator === -1 ? '' : raw.slice(0, separator));
  const id = separator === -1 ? '' : raw.slice(separator + 1);
  if (!id || Number.isNaN(createdAt.getTime())) throw new Error(`${field} is not a run log cursor`);
  return { createdAt, id };
}

function keyset(cursor: { createdAt: Date; id: string }, direction: 'after' | 'before') {
  const op = direction === 'after' ? Op.gt : Op.lt;
  return {
    [Op.or]: [
      { createdAt: { [op]: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { [op]: cursor.id } },
    ],
  };
}

function page(logs: AgentRunLog[], flags: { hasEarlier: boolean; hasMore: boolean }): RunLogPage {
  if (logs.length === 0) return { ...EMPTY_PAGE, ...flags };
  return {
    logs,
    nextCursor: runLogCursor(logs[logs.length - 1]),
    earlierCursor: runLogCursor(logs[0]),
    ...flags,
  };
}

export async function listRunLogs(runId: string, query: RunLogQuery = {}): Promise<RunLogPage> {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_RUN_LOG_LIMIT), 1), MAX_RUN_LOG_LIMIT);
  const after = parseCursor(query.after, 'after');
  const before = parseCursor(query.before, 'before');

  // One row over the limit, only to answer "is there more" exactly — a "load earlier" button that
  // turns out to have nothing to load is worse than no button.
  if (after) {
    const rows = await AgentRunLog.findAll({
      where: { runId, ...keyset(after, 'after') },
      order: [['createdAt', 'ASC'], ['id', 'ASC']],
      limit: limit + 1,
    });
    // Whatever precedes an `after` page is already in the caller's hands.
    return page(rows.slice(0, limit), { hasEarlier: false, hasMore: rows.length > limit });
  }

  const rows = await AgentRunLog.findAll({
    where: { runId, ...(before ? keyset(before, 'before') : {}) },
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    limit: limit + 1,
  });
  return page(rows.slice(0, limit).reverse(), { hasEarlier: rows.length > limit, hasMore: false });
}
