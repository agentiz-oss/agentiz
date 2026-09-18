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
  /**
   * The profile's language (`UserAP.locale`) as a bare BCP-47 primary subtag, or null when the
   * column is empty — which it is on a fresh account, and on a deployment whose panel never offered
   * the field (`config.translation` unset). Null is "nobody said" and is what makes the client fall
   * back to the device's own language rather than to a guess.
   */
  locale: string | null;
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
  /** Issued-at, in seconds. This — not `exp` — is what the server's expiry policy counts from. */
  iat?: number;
  /** Expiry as it was minted, kept for clients that read it; see `verifyMobileToken`. */
  exp?: number;
}
