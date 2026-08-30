import { DataTypes } from 'sequelize';

type QI = {
  addColumn: (table: string, field: string, options: Record<string, unknown>) => Promise<unknown>;
  removeColumn: (table: string, field: string) => Promise<unknown>;
};

const RUNS = 'agentiz_runs';

/**
 * Machine-readable pass/fail read off a verdict stage's own output (see lib/runVerdict.ts and
 * .ai-notes/machine-verdict-plan.md). NULL means "no opinion" — either the pipeline never asked
 * (no stage has `verdict: true`) or it asked and got nothing usable back; the two are
 * indistinguishable on purpose, distinguishable only in the run log (`stage.verdict_retry`).
 */
export async function up({ context }: { context: QI }) {
  await context.addColumn(RUNS, 'verdict', { type: DataTypes.ENUM('pass', 'fail'), allowNull: true });
  await context.addColumn(RUNS, 'verdictReason', { type: DataTypes.TEXT, allowNull: true });
}

export async function down({ context }: { context: QI }) {
  await context.removeColumn(RUNS, 'verdictReason');
  await context.removeColumn(RUNS, 'verdict');
}
