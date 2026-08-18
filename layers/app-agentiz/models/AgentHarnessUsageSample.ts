import { Table, Column, Model, DataType, Default, ForeignKey } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentWorker } from './AgentWorker';
import type { HarnessSignalSource, HarnessWindowState } from '../types/agentiz';

/**
 * Usage-telemetry history — grained by worker, not only by subscription: the measurement happens
 * on the worker machine, so the row is `worker × harnessKey × moment` and the subscription is
 * denormalized at write time. Two workers of one subscription produce redundant series on
 * purpose: a divergence between them is itself a diagnosis (one machine is logged into the wrong
 * account).
 *
 * Written only by AgentCapacityService.applySnapshot — every applied snapshot from any source
 * (report, refresh, classified failure, manual edit) leaves one row, so the series' density does
 * not depend on how telemetry arrives. `subscription.windows` is the "latest sample" cache; this
 * table is history for charts and analysis. Retention is swept by the capacity service
 * (AGENTIZ_USAGE_SAMPLE_RETENTION_DAYS, default 30).
 */
@AdminizerModel({
  model: 'AgentHarnessUsageSample',
  title: 'Agentiz Harness Usage Samples',
  icon: 'monitor',
  navbar: {
    visible: false,
    section: 'Agentiz',
  },
})
@Table({
  tableName: 'agentiz_harness_usage_samples',
  timestamps: true,
  indexes: [
    { fields: ['workerId', 'harnessKey', 'observedAt'] },
    { fields: ['subscriptionId', 'observedAt'] },
    { fields: ['observedAt'] },
  ],
})
export class AgentHarnessUsageSample extends Model<
  InferAttributes<AgentHarnessUsageSample>,
  InferCreationAttributes<AgentHarnessUsageSample>
> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @ForeignKey(() => AgentWorker)
  @Column({ type: DataType.STRING, allowNull: true })
  declare workerId: string | null;

  @Column({ type: DataType.STRING, allowNull: false })
  declare harnessKey: string;

  /** Binding at write time; kept as a plain string so history survives a re-binding. */
  @Column({ type: DataType.STRING, allowNull: true })
  declare subscriptionId: string | null;

  /** Moment of measurement — the source's time, not the insert time. */
  @Column({ type: DataType.DATE, allowNull: false })
  declare observedAt: Date;

  @Column({ type: DataType.STRING, allowNull: false })
  declare source: HarnessSignalSource;

  /** Normalized snapshot [{ key, usedPercent?, resetsAt? }] — what the core can always render. */
  @Column({ type: DataType.JSONB, allowNull: false })
  declare windows: HarnessWindowState[];

  /** Opaque provider metadata — each harness has its own shape, the core never reads it. */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare meta: unknown | null;

  /** Account identity, for auto-binding and cross-worker mismatch warnings. */
  @Column({ type: DataType.STRING, allowNull: true })
  declare accountId: string | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: CreationOptional<Date>;
}
