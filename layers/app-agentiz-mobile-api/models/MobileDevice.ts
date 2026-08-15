import { randomUUID } from 'crypto';
import { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { Column, DataType, Default, Model, Table } from 'sequelize-typescript';
import type { MobilePushPlatform, MobilePushTransport } from '../lib/push';

/**
 * One installation of the mobile app that can be reached with a push notification.
 *
 * Keyed by the push token, not by the device: a reinstall or a token refresh produces a new token
 * and the old one stops being deliverable, so the token is the identity the transports actually
 * address. `userId` is a UserAP id — the same identity the mobile JWT carries — which is what makes
 * "notify whoever owns this project" answerable.
 *
 * Rows are disposable. A transport that reports a token as gone (FCM `UNREGISTERED`, APNs 410)
 * deletes it, and the app registers a fresh one on its next launch.
 */
@AdminizerModel({
  model: 'MobileDevice',
  title: 'Mobile Devices',
  icon: 'smartphone',
  navbar: { visible: false },
})
@Table({ tableName: 'agentiz_mobile_devices', timestamps: true })
export class MobileDevice extends Model<
  InferAttributes<MobileDevice>,
  InferCreationAttributes<MobileDevice>
> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @AdminizerField({ title: 'User', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare userId: number;

  @AdminizerField({ title: 'Platform', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.ENUM('android', 'ios'), allowNull: false })
  declare platform: MobilePushPlatform;

  /**
   * Which service delivers to this token. Derived from the platform when the device registers, but
   * stored rather than recomputed: an iOS build could move from direct APNs to FCM without every
   * already-registered token suddenly being sent to the wrong service.
   */
  @Column({ type: DataType.ENUM('fcm', 'apns'), allowNull: false })
  declare transport: MobilePushTransport;

  // Text, not a string: an APNs token is 64 hex chars and an FCM registration token has no
  // documented upper bound at all.
  @Column({ type: DataType.TEXT, allowNull: false })
  declare token: string;

  @AdminizerField({ title: 'App version', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare appVersion: string | null;

  @AdminizerField({ title: 'Device', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare deviceName: string | null;

  /** Refreshed on every registration call, so a stale install is recognisable before it is pruned. */
  @AdminizerField({ title: 'Last seen', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.DATE, allowNull: true })
  declare lastSeenAt: Date | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: CreationOptional<Date>;
}
