import { Op } from 'sequelize';
import { GithubOAuthApp } from '../models/GithubOAuthApp';
import { GithubOAuthState } from '../models/GithubOAuthState';
import { AgentGitConnection } from '../../app-agentiz/models/AgentGitConnection';
import { GithubApiClient } from '../lib/GithubApiClient';
import {
  buildAuthorizeUrl,
  createState,
  exchangeCode,
  refreshToken as refreshAccessToken,
  revokeToken,
} from '../lib/GithubOAuthClient';
import { apiBaseFor, DEFAULT_GITHUB_SCOPES } from '../types/github';

/** Authorization requests live for 10 minutes — long enough to log into GitHub and approve. */
const STATE_TTL_MS = 10 * 60 * 1000;
/** Refresh a token this long before it actually expires. */
const REFRESH_SKEW_MS = 60 * 1000;

export class GithubOAuthError extends Error {}

/**
 * Drives the authorization-code flow and keeps connection tokens usable:
 * start() -> GitHub consent screen -> handleCallback() -> AgentGitConnection.
 *
 * The connection row belongs to app-agentiz; what lives here is the GitHub dialect of OAuth. Two
 * shapes of it, in fact: a classic OAuth App issues a token that never expires, and an app with
 * "expiring user tokens" enabled issues `expires_in` + `refresh_token`. Both are supported, and
 * `expiresAt === null` means "no expiry", never "stale".
 */
export class GithubOAuthService {
  static scopesFor(app: GithubOAuthApp): string[] {
    const scopes = app.scopes;
    return Array.isArray(scopes) && scopes.length > 0 ? scopes : DEFAULT_GITHUB_SCOPES;
  }

  /** Creates the pending state row and returns the URL the browser has to be sent to. */
  static async start(params: {
    oauthAppId: string;
    redirectUri: string;
    returnTo?: string | null;
    ownerId?: number | null;
  }): Promise<{ authorizeUrl: string; state: string }> {
    const app = await GithubOAuthApp.findByPk(params.oauthAppId);
    if (!app) throw new GithubOAuthError(`GitHub OAuth app ${params.oauthAppId} not found`);
    if (!app.isActive) throw new GithubOAuthError(`GitHub OAuth app ${app.name} is disabled`);

    const state = createState();
    const redirectUri = app.redirectUri || params.redirectUri;

    await GithubOAuthState.create({
      state,
      oauthAppId: app.id,
      redirectUri,
      returnTo: params.returnTo ?? null,
      ownerId: params.ownerId ?? null,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
      usedAt: null,
    });

    // Opportunistic cleanup, cheap enough to do inline.
    await GithubOAuthState.destroy({ where: { expiresAt: { [Op.lt]: new Date(Date.now() - STATE_TTL_MS) } } });

    return {
      state,
      authorizeUrl: buildAuthorizeUrl({
        baseUrl: app.baseUrl,
        clientId: app.clientId,
        redirectUri,
        scopes: this.scopesFor(app),
        state,
      }),
    };
  }

  /**
   * Exchanges the code for a token and upserts the connection. Re-authorizing the same GitHub
   * account through the same application refreshes the existing row instead of duplicating it.
   */
  static async handleCallback(params: {
    code: string;
    state: string;
  }): Promise<{ connection: AgentGitConnection; returnTo: string | null }> {
    const pending = await GithubOAuthState.findOne({ where: { state: params.state } });
    if (!pending) throw new GithubOAuthError('Unknown or already consumed OAuth state');
    if (pending.usedAt) throw new GithubOAuthError('This OAuth state has already been used');
    if (pending.expiresAt.getTime() < Date.now()) {
      await pending.destroy();
      throw new GithubOAuthError('OAuth state expired, start the authorization again');
    }

    const app = await GithubOAuthApp.findByPk(pending.oauthAppId);
    if (!app) throw new GithubOAuthError(`GitHub OAuth app ${pending.oauthAppId} not found`);

    const token = await exchangeCode({
      baseUrl: app.baseUrl,
      clientId: app.clientId,
      clientSecret: app.secrets?.clientSecret,
      code: params.code,
      redirectUri: pending.redirectUri,
    });

    const apiBase = apiBaseFor(app.baseUrl);
    const user = await new GithubApiClient(apiBase, token.access_token).getCurrentUser();

    const attributes = {
      // The API root, not the site root: the core hands this straight to GitHubProvider, which
      // treats `repo.baseUrl` as an API base.
      baseUrl: apiBase,
      externalUserId: String(user.id),
      username: user.login,
      displayName: user.name,
      avatarUrl: user.avatar_url,
      secrets: { accessToken: token.access_token, refreshToken: token.refresh_token },
      scope: token.scope ?? this.scopesFor(app).join(' '),
      expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null,
      status: 'active' as const,
      lastError: null as string | null,
      ownerId: pending.ownerId,
    };

    const existing = await AgentGitConnection.findOne({
      where: { provider: 'github', oauthAppId: app.id, externalUserId: String(user.id) },
    });
    const connection = existing
      ? await existing.update(attributes)
      : await AgentGitConnection.create({ provider: 'github', oauthAppId: app.id, ...attributes });

    await pending.update({ usedAt: new Date() });

    return { connection, returnTo: pending.returnTo };
  }

  /**
   * A usable access token. A classic OAuth App token has no expiry at all, so the common path is
   * simply "return what is stored"; only an expiring token goes through the refresh endpoint.
   */
  static async getAccessToken(connection: AgentGitConnection): Promise<string> {
    const accessToken = connection.secrets?.accessToken;
    if (!accessToken) {
      await connection.update({ status: 'revoked', lastError: 'No access token stored' });
      throw new GithubOAuthError(`GitHub connection ${connection.id} has no access token, re-authorize it`);
    }

    const expiresAt = connection.expiresAt?.getTime();
    if (!expiresAt || expiresAt - REFRESH_SKEW_MS > Date.now()) {
      return accessToken;
    }

    const refresh = connection.secrets?.refreshToken;
    if (!refresh) {
      await connection.update({ status: 'expired', lastError: 'Access token expired and no refresh token is stored' });
      throw new GithubOAuthError(`GitHub connection ${connection.id} expired, re-authorize it`);
    }

    const app = await this.appFor(connection);
    try {
      const token = await refreshAccessToken({
        baseUrl: app.baseUrl,
        clientId: app.clientId,
        clientSecret: app.secrets?.clientSecret,
        refreshToken: refresh,
      });
      await connection.update({
        secrets: {
          accessToken: token.access_token,
          // GitHub rotates the refresh token as well; keep the old one only if none came back.
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
      throw new GithubOAuthError(`Could not refresh GitHub connection ${connection.id}: ${message}`);
    }
  }

  /** The OAuth application a connection was authorized through; `oauthAppId` is opaque to the core. */
  static async appFor(connection: AgentGitConnection): Promise<GithubOAuthApp> {
    const app = connection.oauthAppId ? await GithubOAuthApp.findByPk(connection.oauthAppId) : null;
    if (!app) throw new GithubOAuthError(`GitHub OAuth app ${connection.oauthAppId ?? '(none)'} not found`);
    return app;
  }

  static async apiClientFor(connection: AgentGitConnection): Promise<GithubApiClient> {
    const apiBase = connection.baseUrl ?? apiBaseFor((await this.appFor(connection)).baseUrl);
    return new GithubApiClient(apiBase, await this.getAccessToken(connection));
  }

  /** Deletes the authorization upstream (best effort) and marks the connection revoked locally. */
  static async disconnect(connectionId: string): Promise<AgentGitConnection> {
    const connection = await AgentGitConnection.findByPk(connectionId);
    if (!connection) throw new GithubOAuthError(`GitHub connection ${connectionId} not found`);
    const app = connection.oauthAppId ? await GithubOAuthApp.findByPk(connection.oauthAppId) : null;

    const token = connection.secrets?.accessToken;
    if (app && token) {
      try {
        await revokeToken({
          apiBaseUrl: connection.baseUrl ?? apiBaseFor(app.baseUrl),
          clientId: app.clientId,
          clientSecret: app.secrets?.clientSecret,
          token,
        });
      } catch (error) {
        console.warn(`[app-agentiz-github-integration] token revoke failed: ${String(error)}`);
      }
    }

    return connection.update({ secrets: null, expiresAt: null, status: 'revoked', lastError: null });
  }
}
