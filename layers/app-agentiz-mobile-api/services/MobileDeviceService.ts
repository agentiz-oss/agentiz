import { Op } from 'sequelize';
import { MobileDevice } from '../models/MobileDevice';
import type { MobilePushPlatform, MobilePushTransport } from '../lib/push';
import { MobileAuthError } from './MobileAuthService';

/** Which service delivers to a platform's tokens, unless the client says otherwise. */
const DEFAULT_TRANSPORT: Record<MobilePushPlatform, MobilePushTransport> = {
  android: 'fcm',
  ios: 'apns',
};

export interface DeviceRegistration {
  token: string;
  platform: string;
  transport?: string;
  appVersion?: string | null;
  deviceName?: string | null;
}

/**
 * The push tokens of installed apps.
 *
 * Registration is an upsert on the token, not on the device: the app calls it after every login and
 * on every token refresh, and the same physical phone can hand back a different token at any time.
 * Re-registering an existing token under another user *moves* it, which is what makes signing out
 * on a shared phone stop the previous user's notifications.
 */
export class MobileDeviceService {
  static async register(userId: number, input: DeviceRegistration) {
    const token = String(input.token ?? '').trim();
    if (!token) throw new MobileAuthError(400, 'token is required');
    if (token.length > 4096) throw new MobileAuthError(400, 'token is too long');
    const platform = String(input.platform ?? '').trim().toLowerCase();
    if (platform !== 'android' && platform !== 'ios') {
      throw new MobileAuthError(400, 'platform must be "android" or "ios"');
    }
    const requested = String(input.transport ?? '').trim().toLowerCase();
    const transport: MobilePushTransport = requested === 'fcm' || requested === 'apns'
      ? requested
      : DEFAULT_TRANSPORT[platform];

    const existing = await MobileDevice.findOne({ where: { token } });
    const values = {
      userId,
      platform: platform as MobilePushPlatform,
      transport,
      appVersion: input.appVersion ?? null,
      deviceName: input.deviceName ?? null,
      lastSeenAt: new Date(),
    };
    if (existing) {
      await existing.update(values);
      return existing;
    }
    return MobileDevice.create({ token, ...values } as any);
  }

  /**
   * Forgets one token — what the app calls as it signs out. Scoped to the caller: a token that has
   * already moved to another user must not be removable by the previous one.
   */
  static async unregister(userId: number, token: string): Promise<void> {
    await MobileDevice.destroy({ where: { userId, token: String(token ?? '').trim() } });
  }

  static async forUser(userId: number): Promise<MobileDevice[]> {
    return MobileDevice.findAll({ where: { userId } });
  }

  /** Drops tokens the transports reported as dead. */
  static async forget(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    await MobileDevice.destroy({ where: { token: { [Op.in]: tokens } } });
  }
}
