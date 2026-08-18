import { DataTypes } from 'sequelize';

type QI = {
  sequelize: { getDialect: () => string };
  createTable: (name: string, attrs: Record<string, unknown>) => Promise<unknown>;
  dropTable: (name: string) => Promise<unknown>;
  addColumn: (table: string, field: string, options: Record<string, unknown>) => Promise<unknown>;
  removeColumn: (table: string, field: string) => Promise<unknown>;
  addIndex: (table: string, fields: string[], options?: Record<string, unknown>) => Promise<unknown>;
  removeIndex: (table: string, index: string) => Promise<unknown>;
};

const SUBSCRIPTIONS = 'agentiz_harness_subscriptions';
const BINDINGS = 'agentiz_worker_harnesses';
const SAMPLES = 'agentiz_harness_usage_samples';

/**
 * Harness limits, subscriptions and queue scheduling (см. .ai-notes/harness-limits-and-scheduling.md):
 *
 * - subscriptions own the limit state (`exhaustedUntil` is the gate, `windows` the telemetry);
 * - bindings map worker × harnessKey → subscription;
 * - samples keep the usage history per worker × harness;
 * - jobs learn `harnessKey` (SQL claim filter), `deferReason`/`deferredCount` (limit deferrals
 *   are budgeted separately from attempts) and `scheduleWindow` (working-hours copy);
 * - workers learn `maxConcurrentJobs`, `activeHours`, `timezone`;
 * - runs learn `waitingUntil`/`waitingReason` — deliberately not a new status ENUM value.
 */
export async function up({ context }: { context: QI }) {
  const json = context.sequelize.getDialect() === 'postgres' ? DataTypes.JSONB : DataTypes.JSON;

  await context.createTable(SUBSCRIPTIONS, {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    name: { type: DataTypes.STRING, allowNull: false },
    provider: { type: DataTypes.STRING, allowNull: false, defaultValue: 'other' },
    authKind: { type: DataTypes.STRING, allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    accountId: { type: DataTypes.STRING, allowNull: true },
    resetSchedule: { type: json, allowNull: true },
    windows: { type: json, allowNull: true },
    stopPolicy: { type: json, allowNull: true },
    exhaustedUntil: { type: DataTypes.DATE, allowNull: true },
    exhaustedReason: { type: DataTypes.TEXT, allowNull: true },
    lastSignalAt: { type: DataTypes.DATE, allowNull: true },
    lastSignalSource: { type: DataTypes.STRING, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });

  await context.createTable(BINDINGS, {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    workerId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'agentiz_workers', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    harnessKey: { type: DataTypes.STRING, allowNull: false },
    subscriptionId: {
      type: DataTypes.STRING,
      allowNull: true,
      references: { model: SUBSCRIPTIONS, key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    maxConcurrent: { type: DataTypes.INTEGER, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });
  await context.addIndex(BINDINGS, ['workerId', 'harnessKey'], {
    unique: true,
    name: 'agentiz_worker_harnesses_worker_key_unique',
  });

  await context.createTable(SAMPLES, {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    // Not an FK: samples are history and must survive a worker row being deleted.
    workerId: { type: DataTypes.STRING, allowNull: true },
    harnessKey: { type: DataTypes.STRING, allowNull: false },
    subscriptionId: { type: DataTypes.STRING, allowNull: true },
    observedAt: { type: DataTypes.DATE, allowNull: false },
    source: { type: DataTypes.STRING, allowNull: false },
    windows: { type: json, allowNull: false },
    meta: { type: json, allowNull: true },
    accountId: { type: DataTypes.STRING, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });
  await context.addIndex(SAMPLES, ['workerId', 'harnessKey', 'observedAt'], { name: 'agentiz_usage_samples_worker_key_observed' });
  await context.addIndex(SAMPLES, ['subscriptionId', 'observedAt'], { name: 'agentiz_usage_samples_subscription_observed' });
  await context.addIndex(SAMPLES, ['observedAt'], { name: 'agentiz_usage_samples_observed' });

  await context.addColumn('agentiz_run_jobs', 'harnessKey', { type: DataTypes.STRING, allowNull: true });
  await context.addColumn('agentiz_run_jobs', 'deferReason', { type: DataTypes.STRING, allowNull: true });
  await context.addColumn('agentiz_run_jobs', 'deferredCount', { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });
  await context.addColumn('agentiz_run_jobs', 'scheduleWindow', { type: json, allowNull: true });

  await context.addColumn('agentiz_workers', 'maxConcurrentJobs', { type: DataTypes.INTEGER, allowNull: true });
  await context.addColumn('agentiz_workers', 'activeHours', { type: json, allowNull: true });
  await context.addColumn('agentiz_workers', 'timezone', { type: DataTypes.STRING, allowNull: true });

  await context.addColumn('agentiz_runs', 'waitingUntil', { type: DataTypes.DATE, allowNull: true });
  await context.addColumn('agentiz_runs', 'waitingReason', { type: DataTypes.STRING, allowNull: true });
}

export async function down({ context }: { context: QI }) {
  await context.removeColumn('agentiz_runs', 'waitingReason');
  await context.removeColumn('agentiz_runs', 'waitingUntil');
  await context.removeColumn('agentiz_workers', 'timezone');
  await context.removeColumn('agentiz_workers', 'activeHours');
  await context.removeColumn('agentiz_workers', 'maxConcurrentJobs');
  await context.removeColumn('agentiz_run_jobs', 'scheduleWindow');
  await context.removeColumn('agentiz_run_jobs', 'deferredCount');
  await context.removeColumn('agentiz_run_jobs', 'deferReason');
  await context.removeColumn('agentiz_run_jobs', 'harnessKey');
  await context.dropTable(SAMPLES);
  await context.dropTable(BINDINGS);
  await context.dropTable(SUBSCRIPTIONS);
}
