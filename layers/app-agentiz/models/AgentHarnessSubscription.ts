import { Table, Column, Model, DataType, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import type {
  HarnessResetSchedule,
  HarnessSignalSource,
  HarnessStopPolicy,
  HarnessSubscriptionAuthKind,
  HarnessSubscriptionProvider,
  HarnessWindowState,
} from '../types/agentiz';

/**
 * One provider account/subscription — the thing a usage limit actually belongs to. Two workers
 * logged into the same Claude account exhaust together; one worker running Claude and Codex
 * exhausts independently. That is why the gate state lives here and not on the worker.
 *
 * Holds no secrets: authorization stays on the worker machine. Only a name, the operator's
 * policy, and the abstract state (`windows` telemetry + `exhaustedUntil` enforcement).
 *
 * The split is deliberately hard: `windows` is advisory telemetry, `exhaustedUntil` is the only
 * thing that closes the claim gate. Telemetry reaches enforcement through exactly two configurable
 * paths — `stopPolicy` thresholds and a classified failure — and percentages never re-open a gate
 * before `exhaustedUntil`: a refusal always outranks telemetry.
 */
@AdminizerModel({
  model: 'AgentHarnessSubscription',
  title: 'Agentiz Harness Subscriptions',
  icon: 'card_membership',
  navbar: {
    visible: true,
    section: 'Agentiz',
  },
})
@Table({ tableName: 'agentiz_harness_subscriptions', timestamps: true })
export class AgentHarnessSubscription extends Model<
  InferAttributes<AgentHarnessSubscription>,
  InferCreationAttributes<AgentHarnessSubscription>
> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @AdminizerField({ title: 'Name', required: true, views: { list: true, add: true, edit: true } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare name: string;

  @AdminizerField({
    title: 'Provider',
    type: 'select',
    isIn: { anthropic: 'Anthropic', openai: 'OpenAI', other: 'Other' },
    views: { list: true, add: true, edit: true },
  })
  @Default('other')
  @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'other' })
  declare provider: CreationOptional<HarnessSubscriptionProvider>;

  @AdminizerField({
    title: 'Auth kind',
    type: 'select',
    isIn: { subscription: 'Subscription (5h/weekly windows)', 'api-key': 'API key (RPM/TPM)' },
    views: { list: true, add: true, edit: true },
  })
  @Column({ type: DataType.STRING, allowNull: true })
  declare authKind: HarnessSubscriptionAuthKind | null;

  @AdminizerField({ title: 'Notes', type: 'longtext', views: { list: false, add: true, edit: true } })
  @Column({ type: DataType.TEXT, allowNull: true })
  declare notes: string | null;

  /**
   * Account identity reported by usage telemetry (e.g. the OAuth e-mail). Recorded on first
   * sighting for auto-binding; a mismatching report later is surfaced, never silently re-bound.
   */
  @Column({ type: DataType.STRING, allowNull: true })
  declare accountId: string | null;

  @AdminizerField({
    title: 'Reset schedule',
    type: 'jsoneditor',
    tooltip: '{ kind: "weekly", day: "mon", time: "03:00", timezone: "Europe/Belgrade" } — the declared moment the window resets; the sweep clears exhaustedUntil then.',
    views: { list: false, add: true, edit: true },
  })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare resetSchedule: HarnessResetSchedule | null;

  @AdminizerField({
    title: 'Windows',
    type: 'jsoneditor',
    tooltip: 'Last abstract usage snapshot per window: [{ key, label, usedPercent?, resetsAt?, observedAt, source }]. Advisory telemetry — the gate is exhaustedUntil.',
    views: { list: false, add: false, edit: false },
  })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare windows: HarnessWindowState[] | null;

  @AdminizerField({
    title: 'Stop policy',
    type: 'jsoneditor',
    tooltip: '{ "weekly": { "pauseAtUsedPercent": 80 } } — close the gate preventively when a window\'s usedPercent reaches the threshold, until that window\'s resetsAt.',
    views: { list: false, add: true, edit: true },
  })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare stopPolicy: HarnessStopPolicy | null;

  /** The enforcement field: the subscription is closed to the claim gate until this moment. */
  @AdminizerField({ title: 'Exhausted until', type: 'datetime', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.DATE, allowNull: true })
  declare exhaustedUntil: Date | null;

  @AdminizerField({ title: 'Exhausted reason', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.TEXT, allowNull: true })
  declare exhaustedReason: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastSignalAt: Date | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare lastSignalSource: HarnessSignalSource | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: CreationOptional<Date>;

  /** Whether the claim gate is closed right now. */
  isExhausted(now: Date = new Date()): boolean {
    return Boolean(this.exhaustedUntil && this.exhaustedUntil.getTime() > now.getTime());
  }
}
