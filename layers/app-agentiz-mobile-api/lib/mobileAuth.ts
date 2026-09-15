import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'crypto';
import type { MobileTokenPayload } from '../types/mobileApi';

/** A year. A phone is a signed-in device, not a browser tab: being asked to type an admin password
 * again is the failure mode here, and the app has no way to re-authenticate on its own. */
const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365;

/**
 * How long a mobile session lives, as **current server policy** rather than a number frozen into
 * every token ever issued (see `verifyMobileToken`). Read per call so `AGENTIZ_MOBILE_TOKEN_TTL_SEC`
 * takes effect on restart alone — and, because the policy is what decides expiry, applies to the
 * tokens already sitting on people's phones.
 */
export function mobileTokenTtlSeconds(): number {
  const raw = Number(process.env.AGENTIZ_MOBILE_TOKEN_TTL_SEC);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TOKEN_TTL_SECONDS;
}

/**
 * Past this share of its life a token is handed back renewed on the next authenticated request, so
 * an app that is used at all never reaches the expiry at the end. Half is deliberately generous:
 * renewing on every request would mint a new credential per screen and invalidate nothing.
 */
const RENEW_AFTER_RATIO = 0.5;

/**
 * Signing secret for mobile tokens.
 *
 * The app-manager boot sets `process.env.SECRET` (defaulting to "secret" in dev). A dedicated
 * override lets an operator rotate every mobile session without touching the admin session secret,
 * and — more importantly — keeps mobile tokens from being interchangeable with admin cookies.
 */
export function mobileJwtSecret(): string {
  return process.env.AGENTIZ_MOBILE_JWT_SECRET ?? process.env.SECRET ?? 'secret';
}

export function signMobileToken(payload: Omit<MobileTokenPayload, 'type' | 'iat' | 'exp'>): { token: string; expiresAt: Date } {
  const ttl = mobileTokenTtlSeconds();
  const token = jwt.sign({ ...payload, type: 'mobile' }, mobileJwtSecret(), {
    algorithm: 'HS256',
    expiresIn: ttl,
  });
  return { token, expiresAt: new Date(Date.now() + ttl * 1000) };
}

/**
 * When the session behind `payload` runs out.
 *
 * Counted from the moment of issue (`iat`) plus the **current** TTL, which is why a token minted
 * under a shorter policy stretches when the policy grows and — the half that matters for security —
 * dies early when an operator shortens it. A token with no `iat` (nothing we mint lacks one) falls
 * back to its own `exp`, and with neither it is treated as already expired rather than as eternal.
 */
export function mobileTokenExpiresAt(payload: MobileTokenPayload): Date {
  if (typeof payload.iat === 'number') return new Date((payload.iat + mobileTokenTtlSeconds()) * 1000);
  if (typeof payload.exp === 'number') return new Date(payload.exp * 1000);
  return new Date(0);
}

/** True once the token is far enough through its life that the caller should be handed a fresh one. */
export function mobileTokenNeedsRenewal(payload: MobileTokenPayload, now = new Date()): boolean {
  if (typeof payload.iat !== 'number') return true;
  const ttl = mobileTokenTtlSeconds();
  return now.getTime() >= (payload.iat + ttl * RENEW_AFTER_RATIO) * 1000;
}

/**
 * Verifies signature, expiry and that the token is one we minted for mobile. Throws otherwise.
 *
 * `exp` is checked by us instead of by the library: the lifetime of a session is a property of the
 * server today, not of the day the phone happened to sign in, so a deployment that raises
 * `AGENTIZ_MOBILE_TOKEN_TTL_SEC` (or takes this module's longer default) keeps signed in the
 * people who are already signed in, and one that lowers it logs out the long tail it means to log
 * out. The `exp` claim is still minted, because it is what a client reads to know when to worry.
 */
export function verifyMobileToken(token: string, now = new Date()): MobileTokenPayload {
  const decoded = jwt.verify(token, mobileJwtSecret(), {
    algorithms: ['HS256'],
    ignoreExpiration: true,
  }) as MobileTokenPayload;
  if (!decoded || decoded.type !== 'mobile' || !decoded.sub) {
    throw new Error('Not a mobile token');
  }
  if (mobileTokenExpiresAt(decoded).getTime() <= now.getTime()) {
    throw new Error('Mobile token expired');
  }
  return decoded;
}

/** Pulls the credential out of an `Authorization: Bearer <token>` header. */
export function bearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1].trim() : null;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch; a mismatch is already a "no", so short-circuit it.
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Verifies a plaintext password against whatever Adminizer stored for the UserAP.
 *
 * Adminizer's exact hashing is not visible from this repo (it is a private submodule), so instead
 * of hard-coding one scheme this recognises the formats its dependencies produce and picks the
 * matching verifier at runtime:
 *   - bcrypt / bcryptjs hashes  ($2a$ / $2b$ / $2y$)
 *   - the `password-hash` package's `algorithm$…$hash` strings (sha1/sha256/sha512/md5/pbkdf2)
 *   - a bare plaintext value, as a last resort for dev seeds
 * The optional verifier modules are imported lazily so a deployment that lacks one still boots.
 */
export async function verifyUserPassword(plain: string, stored: string | null | undefined): Promise<boolean> {
  if (!plain || typeof stored !== 'string' || stored.length === 0) return false;

  if (/^\$2[aby]?\$/.test(stored)) {
    try {
      const mod: any = await import('bcryptjs');
      const bcrypt = mod.default ?? mod;
      return await bcrypt.compare(plain, stored);
    } catch {
      return false;
    }
  }

  if (/^(sha1|sha256|sha512|md5|pbkdf2)/i.test(stored) && stored.includes('$')) {
    try {
      const mod: any = await import('password-hash');
      const passwordHash = mod.default ?? mod;
      return Boolean(passwordHash.verify(plain, stored));
    } catch {
      return false;
    }
  }

  return safeEqual(plain, stored);
}
