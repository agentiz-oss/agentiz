import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { signMobileToken, verifyUserPassword } from '../lib/mobileAuth';
import type { MobileAuthUser, MobileLoginResult } from '../types/mobileApi';

/** Carries an HTTP status so the router can answer without leaking internals. */
export class MobileAuthError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Reads a Sequelize instance's attribute either from a model instance or a plain object. */
function attr(record: any, key: string): unknown {
  return typeof record?.get === 'function' ? record.get(key) : record?.[key];
}

/**
 * Authenticates against Adminizer's `UserAP` model and issues mobile session tokens.
 *
 * The model lives in app-adminizer, not here, so it is resolved through the shared Sequelize
 * registry (`sequelize.model('UserAP')`) exactly the way AgentProject.associate() reaches it. Field
 * names are probed rather than assumed: an Adminizer build may call the identifier `login`, `email`
 * or `username`, and store the hash under `password` or `passwordHash`.
 */
export class MobileAuthService {
  static getUserModel(sequelize: Sequelize): ModelStatic<Model> {
    if (!sequelize.isDefined('UserAP')) {
      throw new MobileAuthError(503, 'Authentication is unavailable: the UserAP model is not registered (app-adminizer must be mounted)');
    }
    return sequelize.model('UserAP') as ModelStatic<Model>;
  }

  /** Projects a UserAP row down to the fields the mobile client is allowed to see. */
  static toAuthUser(user: any): MobileAuthUser {
    return {
      id: attr(user, 'id') as number | string,
      login: (attr(user, 'login') ?? attr(user, 'email') ?? String(attr(user, 'id'))) as string,
      fullName: (attr(user, 'fullName') ?? attr(user, 'name') ?? null) as string | null,
      email: (attr(user, 'email') ?? null) as string | null,
    };
  }

  static async login(sequelize: Sequelize, login: string, password: string): Promise<MobileLoginResult> {
    const identifier = (login ?? '').trim();
    if (!identifier || !password) {
      throw new MobileAuthError(400, 'login and password are required');
    }

    const UserAP = this.getUserModel(sequelize);
    const user = await this.findByIdentifier(UserAP, identifier);
    // The same generic message for "no such user" and "wrong password" keeps the endpoint from
    // confirming which admin logins exist.
    if (!user) throw new MobileAuthError(401, 'Invalid credentials');

    const ok = await verifyUserPassword(password, this.storedPassword(user));
    if (!ok) throw new MobileAuthError(401, 'Invalid credentials');

    const authUser = this.toAuthUser(user);
    const { token, expiresAt } = signMobileToken({ sub: String(authUser.id), login: authUser.login });
    return { token, expiresAt: expiresAt.toISOString(), user: authUser };
  }

  /** Re-loads the user a token points at; a deleted account invalidates its outstanding tokens. */
  static async requireUser(sequelize: Sequelize, userId: string | number): Promise<Model> {
    const UserAP = this.getUserModel(sequelize);
    const user = await UserAP.findByPk(userId as any);
    if (!user) throw new MobileAuthError(401, 'User no longer exists');
    return user;
  }

  private static storedPassword(user: any): string | null {
    for (const key of ['password', 'passwordHash', 'hash']) {
      const value = attr(user, key);
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return null;
  }

  private static async findByIdentifier(UserAP: ModelStatic<Model>, identifier: string): Promise<Model | null> {
    const attributes = UserAP.getAttributes();
    const fields = ['login', 'email', 'username'].filter((field) => field in attributes);
    for (const field of fields) {
      const found = await UserAP.findOne({ where: { [field]: identifier } as any });
      if (found) return found;
    }
    return null;
  }
}
