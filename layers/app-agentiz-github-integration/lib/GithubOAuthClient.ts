import { randomBytes } from 'crypto';

/**
 * Thin wrapper over GitHub's OAuth 2.0 authorization-code endpoints
 * (https://docs.github.com/apps/oauth-apps/building-oauth-apps).
 *
 * **No PKCE, deliberately.** The GitLab client in the sibling layer always sends a code challenge;
 * classic GitHub OAuth Apps do not support PKCE at all and silently ignore
 * `code_challenge`/`code_verifier`. What protects this flow is the single-use `state` with a TTL
 * plus the `client_secret` at exchange time. Do not "fix" this by copying the GitLab client.
 */

export interface GithubTokenResponse {
  access_token: string;
  token_type: string;
  scope?: string;
  /**
   * Only present when the application has "expiring user tokens" enabled. Absent means the token
   * never expires, which is the default for a classic OAuth App — not that it is already stale.
   */
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

export function createState(): string {
  return randomBytes(24).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export function buildAuthorizeUrl(params: {
  baseUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
}): string {
  const search = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    state: params.state,
    scope: params.scopes.join(' '),
    // Without this GitHub silently reuses an existing authorization, so re-authorizing after a
    // scope change would hand back the old, narrower token.
    allow_signup: 'false',
  });
  return `${normalizeBaseUrl(params.baseUrl)}/login/oauth/authorize?${search.toString()}`;
}

/**
 * GitHub answers form-urlencoded by default, so `Accept: application/json` is mandatory — and an
 * error comes back with **HTTP 200** and an `error` field in the body, which means checking
 * `res.ok` is not enough.
 */
async function postToken(baseUrl: string, body: Record<string, string>): Promise<GithubTokenResponse> {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/login/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitHub OAuth token request failed: ${res.status} ${text.slice(0, 500)}`);
  }
  let payload: GithubTokenResponse & { error?: string; error_description?: string };
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`GitHub OAuth token response is not JSON: ${text.slice(0, 300)}`);
  }
  if (payload.error) {
    throw new Error(`GitHub OAuth error: ${payload.error}${payload.error_description ? ` — ${payload.error_description}` : ''}`);
  }
  if (!payload.access_token) {
    throw new Error('GitHub OAuth response carried no access_token');
  }
  return payload;
}

export async function exchangeCode(params: {
  baseUrl: string;
  clientId: string;
  clientSecret?: string;
  code: string;
  redirectUri: string;
}): Promise<GithubTokenResponse> {
  return postToken(params.baseUrl, {
    client_id: params.clientId,
    ...(params.clientSecret ? { client_secret: params.clientSecret } : {}),
    code: params.code,
    redirect_uri: params.redirectUri,
  });
}

/** Only usable when the application issues expiring tokens; otherwise there is nothing to refresh. */
export async function refreshToken(params: {
  baseUrl: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}): Promise<GithubTokenResponse> {
  return postToken(params.baseUrl, {
    client_id: params.clientId,
    ...(params.clientSecret ? { client_secret: params.clientSecret } : {}),
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
  });
}

/**
 * Deletes the authorization upstream. Unlike GitLab's `/oauth/revoke`, this is a REST call
 * authenticated with the application's own client id/secret (basic auth), and 404 simply means the
 * token was already gone.
 */
export async function revokeToken(params: {
  apiBaseUrl: string;
  clientId: string;
  clientSecret?: string;
  token: string;
}): Promise<void> {
  if (!params.clientSecret) return;
  const basic = Buffer.from(`${params.clientId}:${params.clientSecret}`).toString('base64');
  const res = await fetch(`${normalizeBaseUrl(params.apiBaseUrl)}/applications/${params.clientId}/token`, {
    method: 'DELETE',
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ access_token: params.token }),
  });
  if (!res.ok && res.status !== 404 && res.status !== 422) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub OAuth revoke failed: ${res.status} ${text.slice(0, 300)}`);
  }
}
