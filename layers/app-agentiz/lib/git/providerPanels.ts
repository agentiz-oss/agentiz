import type { GitProviderType } from '../../types/agentiz';

/**
 * What the core has to know about one hosting platform in order to draw its screen — and nothing
 * else.
 *
 * «Git-провайдеры» (`/agentiz/integrations/git[/:provider]`) is one screen for every platform, but
 * the knowledge it prints belongs to two layers the core must not import: what the platform is
 * called, where its OAuth application is created, which fields that application has, which scopes
 * we ask for. So the layer *describes* itself here, through the app-manager collection
 * `gitProviderPanels`, exactly as it already contributes a `GitConnectionAuthority` and a
 * `WebhookMapper`. Nothing in app-agentiz mentions GitHub or GitLab, and a platform whose layer is
 * unmounted simply has no card — while the connections it authorized stay visible, because those
 * are core rows.
 *
 * **What travels and what does not.** A descriptor is public: it is serialized into the page props
 * of a screen and read by the browser. So it carries the *shape* of the OAuth application form and
 * never a value from it — a client secret is written through the layer's own endpoint and read
 * back by nobody (`maskModelForUI` in each layer), and the webhook secret we issued to the
 * platform never leaves the server except through `maskRepositoryWebhook`. A field marked
 * `secret` is an input, not a value: the screen renders `type="password"` and sends it, and the
 * server never answers with one.
 *
 * **The verbs are a contract, not data.** Every provider layer answers the same `_method` requests
 * at `apiRoute`, so the screen is written once:
 *
 * * `GET  ?_method=getOAuthApps`  → `{ data: [{ id, name, baseUrl, callbackUrl, scopes, isActive, <identity field> }] }`
 * * `POST { _method: 'createOAuthApp', ...fields }`
 * * `POST { _method: 'deleteOAuthApp', id }`
 * * `POST { _method: 'startOAuth', oauthAppId, returnTo }` → `{ data: { authorizeUrl } }`
 *
 * That route is also the one address of this feature that does **not** move: the OAuth callback
 * (`<apiRoute>/oauth/callback`) is registered at the platform, in somebody's GitHub settings page,
 * and a redirect there would break every already-authorized application.
 */
export interface GitProviderPanelField {
  /** The key the layer's `createOAuthApp` reads this value under. */
  name: string;
  label: string;
  /** A write-only input (`type="password"`); the server never sends a value back for it. */
  secret?: boolean;
  placeholder?: string;
  required?: boolean;
  /** One line under the input, when the field is the one people get wrong. */
  hint?: string;
}

export interface GitProviderPanel {
  provider: GitProviderType;
  /** What a person calls the platform: «GitHub». Also used wherever a link names its provider. */
  title: string;
  /** One line under the title on the provider's card. */
  summary: string;
  /**
   * Where this layer answers the `_method` requests above, after the panel prefix
   * (`/agentiz-github`). The core never spells this string itself — that is the whole point.
   */
  apiRoute: string;
  /** The OAuth application form, in the order it is drawn. */
  appFields: GitProviderPanelField[];
  /** Which of those fields identifies an application in the list (`clientId`, `applicationId`). */
  appIdentityField: string;
  /** Where such an application is created at the platform, in one sentence. */
  appHint: string;
  /** Scopes the layer asks for, so what was granted can be compared with what was wanted. */
  defaultScopes: string[];
}

/**
 * provider -> descriptor, on a `Symbol.for` global for the same reason every other registry here
 * is: under tsx this module can be instantiated twice (ESM and CJS graphs), and plain module state
 * would split in two — a layer's registration would be invisible to the screen that needs it.
 */
const PANELS_KEY = Symbol.for('agentiz.gitProviderPanels');
const globalScope = globalThis as unknown as Record<symbol, Map<GitProviderType, GitProviderPanel> | undefined>;
const panels: Map<GitProviderType, GitProviderPanel> =
  globalScope[PANELS_KEY] ?? (globalScope[PANELS_KEY] = new Map());

export function registerGitProviderPanel(panel: GitProviderPanel): void {
  panels.set(panel.provider, panel);
}

export function unregisterGitProviderPanel(provider: GitProviderType): void {
  panels.delete(provider);
}

export function getGitProviderPanel(provider: string): GitProviderPanel | undefined {
  return panels.get(provider as GitProviderType);
}

/** Every platform whose layer is mounted, in a stable order — the cards are drawn in it. */
export function listGitProviderPanels(): GitProviderPanel[] {
  return [...panels.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * How a platform is named on a screen that only has a stored `provider` value to go on.
 *
 * Falls back to the raw value rather than hiding the row: a repository linked through a layer that
 * is no longer mounted is still the project's repository, and printing `gitlab` is a smaller lie
 * than printing nothing.
 */
export function gitProviderTitle(provider: string): string {
  return getGitProviderPanel(provider)?.title ?? provider;
}
