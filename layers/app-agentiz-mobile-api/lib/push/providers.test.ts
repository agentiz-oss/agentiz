import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Signing is Google's and Apple's problem, not this suite's: a real RS256 key would only slow the
// tests down without testing anything they can fail at.
vi.mock('jsonwebtoken', () => ({ default: { sign: () => 'signed-assertion' }, sign: () => 'signed-assertion' }));

import { FirebasePushProvider } from './FirebasePushProvider';
import { GatewayPushProvider } from './GatewayPushProvider';
import { createPushProviders, resetPushProviders } from './providers';
import type { PushMessage } from './index';

const SERVICE_ACCOUNT = JSON.stringify({
  project_id: 'agentiz-test',
  client_email: 'push@agentiz-test.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\\nnot-a-real-key\\n-----END PRIVATE KEY-----',
});

const message: PushMessage = {
  token: 'device-token',
  notification: { title: 'Вопрос агента', body: 'Какую ветку?' },
  data: { type: 'interaction', interactionId: 'int-1' },
  android: { priority: 'HIGH', collapseKey: 'agentiz-run-1', notification: { channelId: 'agentiz-interactions' } },
  apns: { headers: { 'apns-collapse-id': 'agentiz-run-1' }, payload: { aps: { badge: 2, 'thread-id': 'agentiz-run-1' } } },
};

/** An HTTP answer, in the shape `fetch` returns. Only what the providers actually read. */
function response(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
  } as Response;
}

/** Answers the OAuth exchange, then hands the `messages:send` call to `onSend`. */
function fcmFetch(onSend: (url: string, init: RequestInit) => Response) {
  return vi.fn(async (url: string, init: RequestInit) => (
    url.includes('oauth2.googleapis.com')
      ? response(200, { access_token: 'bearer-1', expires_in: 3600 })
      : onSend(url, init)
  ));
}

// `any` throughout: a mock built from a zero-argument implementation types its recorded calls as an
// empty tuple, and every read below would be an index error.
function callUrl(fetchMock: any, callIndex: number): string {
  return String(fetchMock.mock.calls[callIndex][0]);
}

function callInit(fetchMock: any, callIndex: number): any {
  return fetchMock.mock.calls[callIndex][1];
}

function sentMessage(fetchMock: any, callIndex: number): any {
  return JSON.parse(String(callInit(fetchMock, callIndex).body)).message;
}

describe('push providers', () => {
  const env = { ...process.env };

  beforeEach(() => {
    resetPushProviders();
  });

  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
    resetPushProviders();
  });

  describe('provider selection', () => {
    it('sends through Firebase by default, which is what every deployment did before the setting existed', () => {
      delete process.env.PUSH_PROVIDER;
      expect(createPushProviders().fcm.name).toBe('firebase');
    });

    it('sends through the gateway when configuration says so', () => {
      process.env.PUSH_PROVIDER = 'gateway';
      expect(createPushProviders().fcm.name).toBe('gateway');
    });

    it('falls back to Firebase rather than dropping push when the setting is nonsense', () => {
      process.env.PUSH_PROVIDER = 'carrier-pigeon';
      expect(createPushProviders().fcm.name).toBe('firebase');
    });

    it('keeps APNs on its own axis: a raw Apple token can only go to Apple', () => {
      process.env.PUSH_PROVIDER = 'gateway';
      expect(createPushProviders().apns.name).toBe('apns');
    });
  });

  describe('FirebasePushProvider', () => {
    it('is unconfigured — and therefore skipped — without a service account', () => {
      expect(new FirebasePushProvider(undefined).configured()).toBe(false);
    });

    it('exchanges the service account for a bearer token and posts the message to FCM', async () => {
      const fetchMock = fcmFetch(() => response(200, { name: 'projects/agentiz-test/messages/42' }));
      vi.stubGlobal('fetch', fetchMock);

      const result = await new FirebasePushProvider(SERVICE_ACCOUNT).send(message);

      expect(result).toEqual({ success: true, messageId: 'projects/agentiz-test/messages/42' });
      expect(callUrl(fetchMock, 1)).toBe('https://fcm.googleapis.com/v1/projects/agentiz-test/messages:send');
      expect(callInit(fetchMock, 1).headers.Authorization).toBe('Bearer bearer-1');
      // The platform blocks have to survive — they are the whole difference between a notification
      // that collapses and badges correctly and one that does not.
      expect(sentMessage(fetchMock, 1)).toMatchObject({
        token: 'device-token',
        data: { interactionId: 'int-1' },
        android: { collapseKey: 'agentiz-run-1' },
        apns: { payload: { aps: { badge: 2 } } },
      });
    });

    it('reuses the access token across sends', async () => {
      const fetchMock = fcmFetch(() => response(200, {}));
      vi.stubGlobal('fetch', fetchMock);

      const provider = new FirebasePushProvider(SERVICE_ACCOUNT);
      await provider.send(message);
      await provider.send(message);

      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('oauth2'))).toHaveLength(1);
    });

    it('reports an unregistered token as invalid so the row can be deleted', async () => {
      vi.stubGlobal('fetch', fcmFetch(() => response(404, { error: { status: 'UNREGISTERED', message: 'requested entity was not found' } })));

      const result = await new FirebasePushProvider(SERVICE_ACCOUNT).send(message);

      expect(result).toMatchObject({ success: false, reason: 'invalid-token' });
    });

    it('reports 429 as rate limited', async () => {
      vi.stubGlobal('fetch', fcmFetch(() => response(429, { error: { status: 'RESOURCE_EXHAUSTED' } })));

      expect(await new FirebasePushProvider(SERVICE_ACCOUNT).send(message)).toMatchObject({
        success: false,
        reason: 'rate-limited',
      });
    });

    it('reports 5xx as temporary', async () => {
      vi.stubGlobal('fetch', fcmFetch(() => response(503, 'backend unavailable')));

      expect(await new FirebasePushProvider(SERVICE_ACCOUNT).send(message)).toMatchObject({
        success: false,
        reason: 'temporary-error',
      });
    });

    it('does not call bad credentials retryable, and re-mints the bearer next time', async () => {
      const fetchMock = fcmFetch(() => response(401, { error: { status: 'UNAUTHENTICATED' } }));
      vi.stubGlobal('fetch', fetchMock);

      const provider = new FirebasePushProvider(SERVICE_ACCOUNT);
      const result = await provider.send(message);
      await provider.send(message);

      expect(result).toMatchObject({ success: false, reason: 'unknown' });
      // Rotating the key must not need a restart, so the cached bearer is dropped on 401.
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('oauth2'))).toHaveLength(2);
    });

    it('treats a network failure as temporary', async () => {
      vi.stubGlobal('fetch', fcmFetch(() => {
        throw new Error('ECONNRESET');
      }));

      expect(await new FirebasePushProvider(SERVICE_ACCOUNT).send(message)).toMatchObject({
        success: false,
        reason: 'temporary-error',
      });
    });
  });

  describe('GatewayPushProvider', () => {
    it('needs a URL and a key, and nothing from Firebase', () => {
      expect(new GatewayPushProvider(undefined, undefined).configured()).toBe(false);
      expect(new GatewayPushProvider('http://push-gateway:3000', undefined).configured()).toBe(false);
      expect(new GatewayPushProvider('http://push-gateway:3000', 'push_sk_1').configured()).toBe(true);
    });

    it('posts the very same FCM message to the gateway, authorised with the API key', async () => {
      const fetchMock = vi.fn(async () => response(200, { name: 'projects/p/messages/7' }));
      vi.stubGlobal('fetch', fetchMock);

      const result = await new GatewayPushProvider('http://push-gateway:3000/', 'push_sk_1').send(message);

      expect(result).toEqual({ success: true, messageId: 'projects/p/messages/7' });
      expect(callUrl(fetchMock, 0)).toBe('http://push-gateway:3000/v1/messages:send');
      expect(callInit(fetchMock, 0).headers.Authorization).toBe('Bearer push_sk_1');

      // Byte for byte what the Firebase provider would have sent — that identity is what makes
      // switching providers a configuration change.
      const gatewayBody = sentMessage(fetchMock, 0);
      const fcmMock = fcmFetch(() => response(200, {}));
      vi.stubGlobal('fetch', fcmMock);
      await new FirebasePushProvider(SERVICE_ACCOUNT).send(message);
      expect(gatewayBody).toEqual(sentMessage(fcmMock, 1));
    });

    it('accepts a gateway that answers with messageId instead of name', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => response(200, { messageId: 'gw-9' })));

      expect(await new GatewayPushProvider('http://push-gateway:3000', 'push_sk_1').send(message)).toEqual({
        success: true,
        messageId: 'gw-9',
      });
    });

    it('does not retry a rejected API key', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => response(401, { error: 'invalid api key' })));

      expect(await new GatewayPushProvider('http://push-gateway:3000', 'wrong').send(message)).toMatchObject({
        success: false,
        reason: 'unknown',
      });
    });

    it('passes the gateway\'s token verdict through unchanged', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => response(400, { error: { status: 'UNREGISTERED', message: 'invalid registration token' } })));

      expect(await new GatewayPushProvider('http://push-gateway:3000', 'push_sk_1').send(message)).toMatchObject({
        success: false,
        reason: 'invalid-token',
      });
    });

    it('reports gateway rate limiting and outages as retryable', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => response(429, 'slow down')));
      expect(await new GatewayPushProvider('http://push-gateway:3000', 'k').send(message)).toMatchObject({ reason: 'rate-limited' });

      vi.stubGlobal('fetch', vi.fn(async () => response(502, 'bad gateway')));
      expect(await new GatewayPushProvider('http://push-gateway:3000', 'k').send(message)).toMatchObject({ reason: 'temporary-error' });
    });

    it('gives up on a gateway that never answers instead of holding the caller', async () => {
      // What `fetch` does when its AbortSignal fires — the point is that `send` returns at all.
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        expect(init.signal).toBeDefined();
        const timeout = new Error('The operation was aborted due to timeout');
        timeout.name = 'TimeoutError';
        throw timeout;
      }));

      const result = await new GatewayPushProvider('http://push-gateway:3000', 'k', 50).send(message);

      expect(result).toMatchObject({ success: false, reason: 'temporary-error' });
      expect((result as any).error).toContain('timed out');
    });
  });
});
