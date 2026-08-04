import { DataTypes } from 'sequelize';

/**
 * Records why a run exists and makes the task thread a first-class, reproducible worker input.
 * `previousRunId` preserves run-to-run chronology; `triggerCommentId` records the user message
 * that is the primary prompt for event-triggered runs.
 */
type QI = {
  sequelize: {
    getDialect: () => string;
    query: (sql: string) => Promise<unknown>;
  };
  describeTable: (table: string) => Promise<Record<string, unknown>>;
  addColumn: (table: string, column: string, attr: Record<string, unknown>) => Promise<unknown>;
  removeColumn: (table: string, column: string) => Promise<unknown>;
  addIndex: (table: string, fields: string[], options?: Record<string, unknown>) => Promise<unknown>;
  removeIndex: (table: string, name: string) => Promise<unknown>;
};

const TABLE = 'agentiz_runs';

export async function up({ context }: { context: QI }) {
  if (context.sequelize.getDialect() === 'postgres') {
    await context.sequelize.query("ALTER TYPE \"enum_agentiz_runs_trigger\" ADD VALUE IF NOT EXISTS 'human_comment'");
  }
  const existing = await context.describeTable(TABLE);
  if (!existing.triggerCommentId) {
    await context.addColumn(TABLE, 'triggerCommentId', {
      type: DataTypes.STRING,
      allowNull: true,
      references: { model: 'agentiz_task_comments', key: 'id' },
      onUpdate: 'CASCADE', onDelete: 'SET NULL',
    });
  }
  if (!existing.previousRunId) {
    await context.addColumn(TABLE, 'previousRunId', {
      type: DataTypes.STRING,
      allowNull: true,
      references: { model: TABLE, key: 'id' },
      onUpdate: 'CASCADE', onDelete: 'SET NULL',
    });
  }
  await context.addIndex(TABLE, ['triggerCommentId'], { name: 'agentiz_runs_trigger_comment_idx' });
  await context.addIndex(TABLE, ['previousRunId'], { name: 'agentiz_runs_previous_run_idx' });
}

export async function down({ context }: { context: QI }) {
  await context.removeIndex(TABLE, 'agentiz_runs_previous_run_idx');
  await context.removeIndex(TABLE, 'agentiz_runs_trigger_comment_idx');
  const existing = await context.describeTable(TABLE);
  if (existing.previousRunId) await context.removeColumn(TABLE, 'previousRunId');
  if (existing.triggerCommentId) await context.removeColumn(TABLE, 'triggerCommentId');
  // PostgreSQL enum values cannot safely be removed while historical rows may use them.
}
