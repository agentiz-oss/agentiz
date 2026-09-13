import { Table, Column, Model, DataType, Default, ForeignKey, BelongsTo } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { AgentWorker } from './AgentWorker';
import { AgentHarnessSubscription } from './AgentHarnessSubscription';
import type { HarnessAuthState } from '../types/agentiz';

/**
 * The binding "this worker runs this harness under this subscription". Declared by an operator
 * (UI/MCP); additionally the server auto-creates a binding — and an implicit subscription
 * `<worker>/<harness>` — on the first signal about an unknown key, so limit state is never lost
 * to an unfilled directory. Claim logic always goes through the subscription, no branches.
 */
@AdminizerModel({
  model: 'AgentWorkerHarness',
  title: 'Agentiz Worker Harnesses',
  icon: 'hub',
  navbar: {
    visible: false,
    section: 'Agentiz',
  },
})
@Table({
  tableName: 'agentiz_worker_harnesses',
  timestamps: true,
  indexes: [{ unique: true, fields: ['workerId', 'harnessKey'] }],
})
export class AgentWorkerHarness extends Model<
  InferAttributes<AgentWorkerHarness>,
  InferCreationAttributes<AgentWorkerHarness>
> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @ForeignKey(() => AgentWorker)
  @Column({ type: DataType.STRING, allowNull: false })
  declare workerId: string;

  /** Normalized key from lib/harness.ts: 'claude', 'codex', … */
  @AdminizerField({ title: 'Harness', views: { list: true, add: true, edit: false } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare harnessKey: string;

  @ForeignKey(() => AgentHarnessSubscription)
  @Column({ type: DataType.STRING, allowNull: true })
  declare subscriptionId: string | null;

  /** Manual planned stop of exactly this harness on exactly this worker. */
  @AdminizerField({ title: 'Enabled', type: 'boolean', views: { list: true, add: false, edit: true } })
  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare enabled: CreationOptional<boolean>;

  /** Per-harness concurrency cap. Reserved: enforced once the worker runs stages in parallel. */
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare maxConcurrent: number | null;

  /**
   * Whether this machine can authenticate to this harness right now — see `HarnessAuthState`.
   *
   * Written only by `AgentCapacityService.applyAuthState()`, from two sources: the worker's usage
   * reporter (which holds the credential and is therefore the only thing that can tell before a
   * run) and a stage failure a provider classified as `auth`. `null` = nobody said, which behaves
   * exactly as before this column existed.
   */
  @AdminizerField({
    title: 'Auth state',
    type: 'select',
    isIn: { ok: 'Authorized', expired: 'Needs login' },
    views: { list: true, add: false, edit: false },
  })
  @Column({ type: DataType.STRING, allowNull: true })
  declare authState: HarnessAuthState | null;

  /** One short line explaining the state, as the worker or the failed stage put it. */
  @AdminizerField({ title: 'Auth detail', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.TEXT, allowNull: true })
  declare authDetail: string | null;

  /** When the state was last confirmed — a healthy report moves it as much as a failing one. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare authCheckedAt: Date | null;

  /**
   * Start of the current `expired` streak, so a reader learns "не работает с 12.09 20:46" rather
   * than the moment of the latest of two hundred identical reports. Null while authorized.
   */
  @Column({ type: DataType.DATE, allowNull: true })
  declare authFailedSince: Date | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: CreationOptional<Date>;

  @BelongsTo(() => AgentWorker, 'workerId')
  declare worker: AgentWorker;

  @BelongsTo(() => AgentHarnessSubscription, 'subscriptionId')
  declare subscription: AgentHarnessSubscription;

  /** Whether the claim gate must skip this harness on this machine because nobody is logged in. */
  needsLogin(): boolean {
    return this.authState === 'expired';
  }
}
