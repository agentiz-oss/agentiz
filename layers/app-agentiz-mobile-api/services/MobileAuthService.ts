import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { signMobileToken, verifyUserPassword } from '../lib/mobileAuth';
import { isValidTimezone, timezoneOffsetMinutes } from '../../app-agentiz/lib/userTime';
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
    const rawTimezone = attr(user, 'timezone');
    const timezone = isValidTimezone(rawTimezone) ? rawTimezone : null;
    return {
      id: attr(user, 'id') as number | string,
      login: (attr(user, 'login') ?? attr(user, 'email') ?? String(attr(user, 'id'))) as string,
      fullName: (attr(user, 'fullName') ?? attr(user, 'name') ?? null) as string | null,
      email: (attr(user, 'email') ?? null) as string | null,
      timezone,
      utcOffsetMinutes: timezone ? timezoneOffsetMinutes(timezone) : null,
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

    // Adminizer's UserAP stores the credential under `passwordHashed`; fall back to it when the
    // generic field probe (password/passwordHash/hash) finds nothing.
    const stored = this.storedPassword(user) ?? (attr(user, 'passwordHashed') as string | null);
    // Two accepted formats: a bcrypt hash of the bare password (dev seeds), or Adminizer's own
    // `password-hash` string, which it derives from `login + password + AP_PASSWORD_SALT`. Try the
    // bare password first, then reproduce Adminizer's salted input so a dashboard account logs in
    // through the mobile API unchanged.
    let ok = await verifyUserPassword(password, stored);
    if (!ok) {
      const login = String(attr(user, 'login') ?? identifier);
      // Mirror Adminizer's concatenation *exactly* — it interpolates process.env.AP_PASSWORD_SALT
      // with no fallback, so when the salt is unset it hashes the literal string "undefined" onto
      // the end (login.ts, addUser.ts, …). Coalescing to '' here would hash a different input and
      // reject a password the dashboard accepts, so the salt is stringified the same way JS does.
      ok = await verifyUserPassword(`${login}${password}${process.env.AP_PASSWORD_SALT}`, stored);
    }
    if (!ok) throw new MobileAuthError(401, 'Invalid credentials');

    const authUser = this.toAuthUser(user);
    const { token, expiresAt } = signMobileToken({ sub: String(authUser.id), login: authUser.login });
    return { token, expiresAt: expiresAt.toISOString(), user: authUser };
  }

  /**
   * Re-loads the user a token points at; a deleted account invalidates its outstanding tokens.
   *
   * The global groups come with it, and that is not decoration: every token check reads
   * `user.groups`, so a user row loaded without them makes each of those checks quietly false —
   * the administrator flag and the graph's bypass token in particular. The association is
   * `belongsToMany(..., { as: 'groups' })`, wired by app-adminizer; where it is missing (an older
   * panel, a host that overrode UserAP) the include is skipped and the caller falls back to
   * ownership and membership alone, which is the pre-existing behaviour rather than a new hole.
   */
  static async requireUser(sequelize: Sequelize, userId: string | number): Promise<Model> {
    const UserAP = this.getUserModel(sequelize);
    const hasGroups = Boolean((UserAP.associations as Record<string, unknown> | undefined)?.groups);
    const user = await UserAP.findByPk(userId as any, hasGroups ? { include: [{ association: 'groups' }] } : undefined);
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
