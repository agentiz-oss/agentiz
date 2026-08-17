type QI = {
  addIndex: (table: string, fields: string[], options?: Record<string, unknown>) => Promise<unknown>;
  removeIndex: (table: string, index: string) => Promise<unknown>;
};

const TABLE = 'agentiz_run_logs';
const INDEX = 'agentiz_run_logs_stream_idx';

/**
 * Live tool-call events turn a run's log from tens of rows into hundreds, and every reader now
 * pages it by `(createdAt, id)` within one run (see `lib/runLogs.ts`). The existing `['runId']`
 * index still forces a sort of the whole run on each poll; this one serves the ordering too.
 */
export async function up({ context }: { context: QI }) {
  await context.addIndex(TABLE, ['runId', 'createdAt'], { name: INDEX });
}

export async function down({ context }: { context: QI }) {
  await context.removeIndex(TABLE, INDEX);
}
