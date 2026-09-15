import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  mobileTokenExpiresAt,
  mobileTokenNeedsRenewal,
  mobileTokenTtlSeconds,
  signMobileToken,
  verifyMobileToken,
} from './mobileAuth';

const DAY = 24 * 60 * 60 * 1000;
const SIGNED_IN_AT = new Date('2026-01-01T00:00:00.000Z');

/** Mints a token as if the phone had signed in at `at`, under whatever TTL is set right then. */
function signAt(at: Date) {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  try {
    return signMobileToken({ sub: '7', login: 'ivan' });
  } finally {
    vi.useRealTimers();
  }
}

describe('mobile session lifetime', () => {
  const originalTtl = process.env.AGENTIZ_MOBILE_TOKEN_TTL_SEC;
  const originalSecret = process.env.AGENTIZ_MOBILE_JWT_SECRET;

  beforeEach(() => {
    process.env.AGENTIZ_MOBILE_JWT_SECRET = 'test-secret';
    delete process.env.AGENTIZ_MOBILE_TOKEN_TTL_SEC;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalTtl === undefined) delete process.env.AGENTIZ_MOBILE_TOKEN_TTL_SEC;
    else process.env.AGENTIZ_MOBILE_TOKEN_TTL_SEC = originalTtl;
    if (originalSecret === undefined) delete process.env.AGENTIZ_MOBILE_JWT_SECRET;
    else process.env.AGENTIZ_MOBILE_JWT_SECRET = originalSecret;
  });

  it('defaults to a year and lets an operator override it', () => {
    expect(mobileTokenTtlSeconds()).toBe(60 * 60 * 24 * 365);
    process.env.AGENTIZ_MOBILE_TOKEN_TTL_SEC = '3600';
    expect(mobileTokenTtlSeconds()).toBe(3600);
    // Garbage and nonsense fall back rather than producing a token that is born expired.
    process.env.AGENTIZ_MOBILE_TOKEN_TTL_SEC = 'soon';
    expect(mobileTokenTtlSeconds()).toBe(60 * 60 * 24 * 365);
    process.env.AGENTIZ_MOBILE_TOKEN_TTL_SEC = '0';
    expect(mobileTokenTtlSeconds()).toBe(60 * 60 * 24 * 365);
  });

  it('keeps a phone signed in when the policy grows under it', () => {
    // The token on the phone today: minted when a mobile session lasted 30 days, and long past
    // the `exp` baked into it. Raising the policy has to reach it, or "make it a year" would only
    // help people who log in again first — which is the very thing being avoided.
    process.env.AGENTIZ_MOBILE_TOKEN_TTL_SEC = String(30 * 24 * 60 * 60);
    const { token, expiresAt } = signAt(SIGNED_IN_AT);
    expect(expiresAt.getTime()).toBe(SIGNED_IN_AT.getTime() + 30 * DAY);

    const wellPastTheOldExpiry = new Date(SIGNED_IN_AT.getTime() + 200 * DAY);
    expect(() => verifyMobileToken(token, wellPastTheOldExpiry)).toThrow();

    delete process.env.AGENTIZ_MOBILE_TOKEN_TTL_SEC;
    const payload = verifyMobileToken(token, wellPastTheOldExpiry);
    expect(payload.sub).toBe('7');
    expect(mobileTokenExpiresAt(payload).getTime()).toBe(SIGNED_IN_AT.getTime() + 365 * DAY);
  });

  it('logs out the long tail when the policy shrinks under it', () => {
    // The other half of deciding expiry from policy rather than from the minted `exp`: shortening
    // the TTL actually shortens the sessions that are already out there.
    const { token } = signAt(SIGNED_IN_AT);
    const twoDaysLater = new Date(SIGNED_IN_AT.getTime() + 2 * DAY);
    expect(verifyMobileToken(token, twoDaysLater).login).toBe('ivan');

    process.env.AGENTIZ_MOBILE_TOKEN_TTL_SEC = String(24 * 60 * 60);
    expect(() => verifyMobileToken(token, twoDaysLater)).toThrow();
  });

  it('asks for a renewal only past half the lifetime', () => {
    const { token } = signAt(SIGNED_IN_AT);
    const payload = verifyMobileToken(token, new Date(SIGNED_IN_AT.getTime() + DAY));
    expect(mobileTokenNeedsRenewal(payload, new Date(SIGNED_IN_AT.getTime() + 100 * DAY))).toBe(false);
    expect(mobileTokenNeedsRenewal(payload, new Date(SIGNED_IN_AT.getTime() + 183 * DAY))).toBe(true);
  });

  it('still refuses a foreign, tampered or non-mobile token', () => {
    const { token } = signAt(SIGNED_IN_AT);
    const now = new Date(SIGNED_IN_AT.getTime() + DAY);

    process.env.AGENTIZ_MOBILE_JWT_SECRET = 'another-secret';
    expect(() => verifyMobileToken(token, now)).toThrow();
    process.env.AGENTIZ_MOBILE_JWT_SECRET = 'test-secret';

    // An admin-shaped JWT signed with the same secret is not a mobile session.
    const notMobile = jwt.sign({ sub: '7', login: 'ivan' }, 'test-secret', { algorithm: 'HS256', expiresIn: 3600 });
    expect(() => verifyMobileToken(notMobile, now)).toThrow(/Not a mobile token/);

    // `alg: none` must not become a way in now that the library is told to skip expiry.
    const unsigned = jwt.sign({ sub: '7', login: 'ivan', type: 'mobile' }, '', { algorithm: 'none' });
    expect(() => verifyMobileToken(unsigned, now)).toThrow();
  });

  it('treats a token carrying no issue time as expired, never as eternal', () => {
    const noIat = jwt.sign({ sub: '7', login: 'ivan', type: 'mobile' }, 'test-secret', {
      algorithm: 'HS256',
      noTimestamp: true,
    });
    expect(() => verifyMobileToken(noIat, new Date())).toThrow();
  });
});
