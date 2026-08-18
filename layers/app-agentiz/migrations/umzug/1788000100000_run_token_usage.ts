import { DataTypes } from 'sequelize';

type QI = {
  addColumn: (table: string, field: string, options: Record<string, unknown>) => Promise<unknown>;
  removeColumn: (table: string, field: string) => Promise<unknown>;
};

const RUNS = 'agentiz_runs';

/**
 * Run-level token spend, accumulated from every applied worker result. Columns, not JSON:
 * charts aggregate these in SQL and JSON operators differ between postgres and sqlite.
 * NULL = never reported (old runs, executors without usage reporting).
 */
const COLUMNS: Record<string, Record<string, unknown>> = {
  usageInputTokens: { type: DataTypes.BIGINT, allowNull: true },
  usageOutputTokens: { type: DataTypes.BIGINT, allowNull: true },
  usageCacheReadTokens: { type: DataTypes.BIGINT, allowNull: true },
  usageCacheWriteTokens: { type: DataTypes.BIGINT, allowNull: true },
  usageTotalTokens: { type: DataTypes.BIGINT, allowNull: true },
  usageEstimatedCostUsd: { type: DataTypes.FLOAT, allowNull: true },
};

export async function up({ context }: { context: QI }) {
  for (const [field, options] of Object.entries(COLUMNS)) {
    await context.addColumn(RUNS, field, options);
  }
}

export async function down({ context }: { context: QI }) {
  for (const field of Object.keys(COLUMNS)) {
    await context.removeColumn(RUNS, field);
  }
}
