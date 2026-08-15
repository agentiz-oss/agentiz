import { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import { Column, DataType, Model, Table } from 'sequelize-typescript';

/**
 * One push credential or switch, stored so it can be changed without a deploy.
 *
 * Everything here has an environment variable of the same name, and the variable stays the way a
 * deployment is *configured* — this table is the way it is *administered*, from MCP or the panel,
 * when editing `.env` and restarting the process is not available. A row wins over the variable
 * (that is the point of setting one), and deleting the row falls back to it.
 *
 * The values are secrets: a Firebase service account and an APNs signing key can send notifications
 * to every install of the app. Nothing reads them back out in full — `PushSettingsService.describe`
 * masks, and there is no MCP tool or endpoint that returns a stored value.
 */
@AdminizerModel({
  model: 'MobilePushSetting',
  title: 'Push Settings',
  icon: 'notifications_active',
  navbar: { visible: false },
})
@Table({ tableName: 'agentiz_mobile_push_settings', timestamps: true })
export class MobilePushSetting extends Model<
  InferAttributes<MobilePushSetting>,
  InferCreationAttributes<MobilePushSetting>
> {
  /** The environment-variable name, e.g. `PUSH_PROVIDER` or `AGENTIZ_APNS_KEY_ID`. */
  @AdminizerField({ title: 'Key', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, primaryKey: true })
  declare key: string;

  // Text: a service-account JSON and a `.p8` key are both multi-kilobyte when given inline.
  @Column({ type: DataType.TEXT, allowNull: false })
  declare value: string;

  /** Who set it last, for the audit trail a credential change deserves. */
  @AdminizerField({ title: 'Updated by', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare updatedBy: string | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: CreationOptional<Date>;
}
