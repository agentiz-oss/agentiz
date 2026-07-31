import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'crypto';
import type { MobileTokenPayload } from '../types/mobileApi';

/** Token lifetime. A phone stays logged in for a month unless an operator shortens it. */
const TOKEN_TTL_SECONDS = Number(process.env.AGENTIZ_MOBILE_TOKEN_TTL_SEC ?? 60 * 60 * 24 * 30);

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

export function signMobileToken(payload: Omit<MobileTokenPayload, 'type'>): { token: string; expiresAt: Date } {
  const token = jwt.sign({ ...payload, type: 'mobile' } satisfies MobileTokenPayload, mobileJwtSecret(), {
    algorithm: 'HS256',
    expiresIn: TOKEN_TTL_SECONDS,
  });
  return { token, expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000) };
}

/** Verifies signature, expiry and that the token is one we minted for mobile. Throws otherwise. */
export function verifyMobileToken(token: string): MobileTokenPayload {
  const decoded = jwt.verify(token, mobileJwtSecret(), { algorithms: ['HS256'] }) as MobileTokenPayload;
  if (!decoded || decoded.type !== 'mobile' || !decoded.sub) {
    throw new Error('Not a mobile token');
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
