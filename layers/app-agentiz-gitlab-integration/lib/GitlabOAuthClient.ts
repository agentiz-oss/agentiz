import { createHash, randomBytes } from 'crypto';

/**
 * Thin wrapper over GitLab's OAuth 2.0 authorization-code endpoints
 * (https://docs.gitlab.com/ee/api/oauth2.html). PKCE is always used: it costs nothing for a
 * confidential application and makes the flow safe if the app is later re-registered as public.
 */

export interface GitlabTokenResponse {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  scope?: string;
  /** Seconds. GitLab defaults to 2 hours; older instances may omit it (token never expires). */
  expires_in?: number;
  created_at?: number;
}

export interface AuthorizeUrlParams {
  baseUrl: string;
  applicationId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
}

export function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64UrlEncode(randomBytes(48));
  const codeChallenge = base64UrlEncode(createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

export function createState(): string {
  return base64UrlEncode(randomBytes(24));
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export function buildAuthorizeUrl(params: AuthorizeUrlParams): string {
  const search = new URLSearchParams({
    client_id: params.applicationId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    state: params.state,
    scope: params.scopes.join(' '),
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${normalizeBaseUrl(params.baseUrl)}/oauth/authorize?${search.toString()}`;
}

async function postToken(baseUrl: string, body: Record<string, string>): Promise<GitlabTokenResponse> {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitLab OAuth token request failed: ${res.status} ${text.slice(0, 500)}`);
  }
  return JSON.parse(text) as GitlabTokenResponse;
}

export async function exchangeCode(params: {
  baseUrl: string;
  applicationId: string;
  clientSecret?: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<GitlabTokenResponse> {
  return postToken(params.baseUrl, {
    client_id: params.applicationId,
    ...(params.clientSecret ? { client_secret: params.clientSecret } : {}),
    code: params.code,
    grant_type: 'authorization_code',
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });
}

export async function refreshToken(params: {
  baseUrl: string;
  applicationId: string;
  clientSecret?: string;
  refreshToken: string;
  redirectUri: string;
}): Promise<GitlabTokenResponse> {
  return postToken(params.baseUrl, {
    client_id: params.applicationId,
    ...(params.clientSecret ? { client_secret: params.clientSecret } : {}),
    refresh_token: params.refreshToken,
    grant_type: 'refresh_token',
    redirect_uri: params.redirectUri,
  });
}

export async function revokeToken(params: {
  baseUrl: string;
  applicationId: string;
  clientSecret?: string;
  token: string;
}): Promise<void> {
  const res = await fetch(`${normalizeBaseUrl(params.baseUrl)}/oauth/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: params.applicationId,
      ...(params.clientSecret ? { client_secret: params.clientSecret } : {}),
      token: params.token,
    }),
  });
  // A already-invalid token answers 200 as well; only transport failures are worth reporting.
  if (!res.ok && res.status !== 401) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitLab OAuth revoke failed: ${res.status} ${text.slice(0, 300)}`);
  }
}
