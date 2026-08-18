/**
 * Shapes the mobile client relies on. Kept deliberately small: the mobile app only needs to log in
 * and read the projects it owns, so nothing here mirrors the full admin model.
 */

/** The authenticated admin, reduced to what a phone screen actually shows. */
export interface MobileAuthUser {
  id: number | string;
  login: string;
  fullName: string | null;
  email: string | null;
  /** IANA name from the profile (`UserAP.timezone`); null when unset or unusable. */
  timezone: string | null;
  /**
   * That zone's offset from UTC in minutes, computed server-side at response time. The client has
   * no tz database, so this is what it applies to ISO timestamps; refreshed on every login and
   * session restore, which keeps DST drift bounded to one app restart.
   */
  utcOffsetMinutes: number | null;
}

/** Response of POST /auth/login. `expiresAt` lets the client refresh before the token dies. */
export interface MobileLoginResult {
  token: string;
  expiresAt: string;
  user: MobileAuthUser;
}

/**
 * Claims carried by the signed token. `type: 'mobile'` keeps these tokens from being confused with
 * any other JWT the server might issue — a token minted elsewhere will not pass verifyMobileToken.
 */
export interface MobileTokenPayload {
  sub: string;
  login: string;
  type: 'mobile';
}
