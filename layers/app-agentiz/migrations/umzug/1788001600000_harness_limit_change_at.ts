import { DataTypes } from 'sequelize';

type QI = {
  sequelize: {
    query: (sql: string) => Promise<unknown>;
  };
  addColumn: (table: string, field: string, options: Record<string, unknown>) => Promise<unknown>;
  removeColumn: (table: string, field: string) => Promise<unknown>;
};

const SUBSCRIPTIONS = 'agentiz_harness_subscriptions';

/**
 * `lastSignalAt` moves on every heartbeat.  Keep a separate timestamp for the last change in
 * quota values so the panel can distinguish a live reporter from a subscription that is idle.
 * Existing rows get their last signal as an honest lower-fidelity starting point; future reports
 * refine it only when their normalized windows actually differ.
 */
export async function up({ context }: { context: QI }) {
  await context.addColumn(SUBSCRIPTIONS, 'lastLimitChangeAt', { type: DataTypes.DATE, allowNull: true });
  await context.sequelize.query(
    `UPDATE ${SUBSCRIPTIONS} SET "lastLimitChangeAt" = "lastSignalAt" WHERE "lastLimitChangeAt" IS NULL AND "lastSignalAt" IS NOT NULL`,
  );
}

export async function down({ context }: { context: QI }) {
  await context.removeColumn(SUBSCRIPTIONS, 'lastLimitChangeAt');
}
