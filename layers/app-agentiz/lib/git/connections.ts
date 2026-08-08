import type { AgentGitConnection } from '../../models/AgentGitConnection';
import type { GitProviderType } from '../../types/agentiz';

/**
 * The half of a git connection the core cannot own.
 *
 * `AgentGitConnection` stores the tokens, but *renewing* them is platform business: GitLab rotates
 * refresh tokens through its own endpoint with an application id and PKCE-shaped state, GitHub OAuth
 * Apps often issue tokens that never expire at all. So the core keeps the row and asks the layer
 * that authorized it whenever a live token or a repository listing is needed.
 */
export interface GitConnectionAuthority {
  provider: GitProviderType;
  /** How the token is presented to the platform's REST API. */
  authScheme: 'token' | 'bearer';
  /** A usable access token; the layer decides whether it has to be refreshed first. */
  accessToken(connection: AgentGitConnection): Promise<string>;
  /** Re-mirror the repositories reachable through this connection into AgentRepository. */
  syncRepositories(connection: AgentGitConnection): Promise<RepositorySyncResult>;
  /** Revoke the token upstream (best effort) and mark the connection locally. */
  disconnect?(connection: AgentGitConnection): Promise<void>;
}

export interface RepositorySyncResult {
  connectionId: string;
  fetched: number;
  created: number;
  updated: number;
  errors: string[];
}

/**
 * provider -> authority, filled by each provider layer while it mounts.
 *
 * Parked on a global symbol for the same reason as the adapter map in ./index.ts: under tsx this
 * file can be instantiated twice (ESM and CJS graphs), and plain module state would then split into
 * two maps — a layer's registration would be invisible to the resolver that needs it.
 */
const AUTHORITIES_KEY = Symbol.for('agentiz.gitConnectionAuthorities');
const globalScope = globalThis as unknown as Record<symbol, Map<GitProviderType, GitConnectionAuthority> | undefined>;
const authorities: Map<GitProviderType, GitConnectionAuthority> =
  globalScope[AUTHORITIES_KEY] ?? (globalScope[AUTHORITIES_KEY] = new Map());

export function registerGitConnectionAuthority(authority: GitConnectionAuthority): void {
  authorities.set(authority.provider, authority);
}

export function unregisterGitConnectionAuthority(provider: GitProviderType): void {
  authorities.delete(provider);
}

export function getGitConnectionAuthority(provider: GitProviderType): GitConnectionAuthority | undefined {
  return authorities.get(provider);
}

/** Providers whose layers are mounted right now. */
export function listGitConnectionProviders(): GitProviderType[] {
  return [...authorities.keys()];
}

/**
 * Same idea as `createGitProviderFor`: fail with the reason rather than return undefined.
 *
 * A connection can perfectly well exist in the database while the layer that authorized it is not
 * mounted — the row stays, but nobody can refresh its token. A silent `undefined` would send the
 * next reader looking for a data problem instead of a missing layer.
 */
export function requireGitConnectionAuthority(provider: GitProviderType): GitConnectionAuthority {
  const authority = authorities.get(provider);
  if (!authority) {
    const available = listGitConnectionProviders().join(', ') || 'none';
    throw new Error(
      `No connection authority for "${provider}": the layer that serves it is not mounted (available: ${available})`,
    );
  }
  return authority;
}
