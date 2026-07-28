import { Op } from 'sequelize';
import { GitlabOAuthApp } from '../models/GitlabOAuthApp';
import { GitlabOAuthState } from '../models/GitlabOAuthState';
import { GitlabConnection } from '../models/GitlabConnection';
import { GitlabApiClient } from '../lib/GitlabApiClient';
import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  exchangeCode,
  refreshToken as refreshAccessToken,
  revokeToken,
} from '../lib/GitlabOAuthClient';
import { DEFAULT_GITLAB_SCOPES } from '../types/gitlab';

/** Authorization requests live for 10 minutes — long enough to log into GitLab and approve. */
const STATE_TTL_MS = 10 * 60 * 1000;
/** Refresh a token this long before it actually expires. */
const REFRESH_SKEW_MS = 60 * 1000;

export class GitlabOAuthError extends Error {}

/**
 * Drives the authorization-code flow and keeps connection tokens usable:
 * start() -> GitLab consent screen -> handleCallback() -> GitlabConnection, then getAccessToken()
 * transparently refreshes whenever the stored access token is about to expire.
 */
export class GitlabOAuthService {
  static scopesFor(app: GitlabOAuthApp): string[] {
    const scopes = app.scopes;
    return Array.isArray(scopes) && scopes.length > 0 ? scopes : DEFAULT_GITLAB_SCOPES;
  }

  /** Creates the pending state row and returns the URL the browser has to be sent to. */
  static async start(params: {
    oauthAppId: string;
    redirectUri: string;
    returnTo?: string | null;
    ownerId?: number | null;
  }): Promise<{ authorizeUrl: string; state: string }> {
    const app = await GitlabOAuthApp.findByPk(params.oauthAppId);
    if (!app) throw new GitlabOAuthError(`GitLab OAuth app ${params.oauthAppId} not found`);
    if (!app.isActive) throw new GitlabOAuthError(`GitLab OAuth app ${app.name} is disabled`);

    const { codeVerifier, codeChallenge } = createPkcePair();
    const state = createState();
    const redirectUri = app.redirectUri || params.redirectUri;

    await GitlabOAuthState.create({
      state,
      oauthAppId: app.id,
      codeVerifier,
      redirectUri,
      returnTo: params.returnTo ?? null,
      ownerId: params.ownerId ?? null,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
      usedAt: null,
    });

    // Opportunistic cleanup, cheap enough to do inline.
    await GitlabOAuthState.destroy({ where: { expiresAt: { [Op.lt]: new Date(Date.now() - STATE_TTL_MS) } } });

    return {
      state,
      authorizeUrl: buildAuthorizeUrl({
        baseUrl: app.baseUrl,
        applicationId: app.applicationId,
        redirectUri,
        scopes: this.scopesFor(app),
        state,
        codeChallenge,
      }),
    };
  }

  /**
   * Exchanges the code for tokens and upserts the connection. Re-authorizing the same GitLab
   * account through the same application refreshes the existing row instead of duplicating it.
   */
  static async handleCallback(params: {
    code: string;
    state: string;
  }): Promise<{ connection: GitlabConnection; returnTo: string | null }> {
    const pending = await GitlabOAuthState.findOne({ where: { state: params.state } });
    if (!pending) throw new GitlabOAuthError('Unknown or already consumed OAuth state');
    if (pending.usedAt) throw new GitlabOAuthError('This OAuth state has already been used');
    if (pending.expiresAt.getTime() < Date.now()) {
      await pending.destroy();
      throw new GitlabOAuthError('OAuth state expired, start the authorization again');
    }

    const app = await GitlabOAuthApp.findByPk(pending.oauthAppId);
    if (!app) throw new GitlabOAuthError(`GitLab OAuth app ${pending.oauthAppId} not found`);

    const token = await exchangeCode({
      baseUrl: app.baseUrl,
      applicationId: app.applicationId,
      clientSecret: app.secrets?.clientSecret,
      code: params.code,
      redirectUri: pending.redirectUri,
      codeVerifier: pending.codeVerifier,
    });

    const client = new GitlabApiClient(app.baseUrl, token.access_token);
    const user = await client.getCurrentUser();

    const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null;
    const attributes = {
      gitlabUserId: user.id,
      username: user.username,
      displayName: user.name,
      avatarUrl: user.avatar_url,
      secrets: { accessToken: token.access_token, refreshToken: token.refresh_token },
      scope: token.scope ?? this.scopesFor(app).join(' '),
      expiresAt,
      status: 'active' as const,
      lastError: null as string | null,
      ownerId: pending.ownerId,
    };

    const existing = await GitlabConnection.findOne({
      where: { oauthAppId: app.id, gitlabUserId: user.id },
    });
    const connection = existing
      ? await existing.update(attributes)
      : await GitlabConnection.create({ oauthAppId: app.id, ...attributes });

    await pending.update({ usedAt: new Date() });

    return { connection, returnTo: pending.returnTo };
  }

  /**
   * Returns a usable access token, refreshing it first when it is expired or about to expire.
   * Every GitLab call in this layer goes through here.
   */
  static async getAccessToken(connection: GitlabConnection): Promise<string> {
    const accessToken = connection.secrets?.accessToken;
    if (!accessToken) {
      await connection.update({ status: 'revoked', lastError: 'No access token stored' });
      throw new GitlabOAuthError(`GitLab connection ${connection.id} has no access token, re-authorize it`);
    }

    const expiresAt = connection.expiresAt?.getTime();
    if (!expiresAt || expiresAt - REFRESH_SKEW_MS > Date.now()) {
      return accessToken;
    }

    const refresh = connection.secrets?.refreshToken;
    if (!refresh) {
      await connection.update({ status: 'expired', lastError: 'Access token expired and no refresh token is stored' });
      throw new GitlabOAuthError(`GitLab connection ${connection.id} expired, re-authorize it`);
    }

    const app = await GitlabOAuthApp.findByPk(connection.oauthAppId);
    if (!app) throw new GitlabOAuthError(`GitLab OAuth app ${connection.oauthAppId} not found`);

    try {
      const token = await refreshAccessToken({
        baseUrl: app.baseUrl,
        applicationId: app.applicationId,
        clientSecret: app.secrets?.clientSecret,
        refreshToken: refresh,
        redirectUri: app.redirectUri ?? '',
      });
      await connection.update({
        secrets: {
          accessToken: token.access_token,
          // GitLab rotates refresh tokens; keep the old one only if none came back.
          refreshToken: token.refresh_token ?? refresh,
        },
        expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null,
        scope: token.scope ?? connection.scope,
        status: 'active',
        lastError: null,
      });
      return token.access_token;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await connection.update({ status: 'expired', lastError: message });
      throw new GitlabOAuthError(`Could not refresh GitLab connection ${connection.id}: ${message}`);
    }
  }

  static async apiClientFor(connection: GitlabConnection): Promise<GitlabApiClient> {
    const app = await GitlabOAuthApp.findByPk(connection.oauthAppId);
    if (!app) throw new GitlabOAuthError(`GitLab OAuth app ${connection.oauthAppId} not found`);
    return new GitlabApiClient(app.baseUrl, await this.getAccessToken(connection));
  }

  /** Revokes the token upstream (best effort) and marks the connection revoked locally. */
  static async disconnect(connectionId: string): Promise<GitlabConnection> {
    const connection = await GitlabConnection.findByPk(connectionId);
    if (!connection) throw new GitlabOAuthError(`GitLab connection ${connectionId} not found`);
    const app = await GitlabOAuthApp.findByPk(connection.oauthAppId);

    const token = connection.secrets?.accessToken;
    if (app && token) {
      try {
        await revokeToken({
          baseUrl: app.baseUrl,
          applicationId: app.applicationId,
          clientSecret: app.secrets?.clientSecret,
          token,
        });
      } catch (error) {
        console.warn(`[app-agentiz-gitlab-integration] token revoke failed: ${String(error)}`);
      }
    }

    return connection.update({ secrets: null, expiresAt: null, status: 'revoked', lastError: null });
  }
}
