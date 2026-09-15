/**
 * Vite's custom module entry names are stable (for example AgentizApp.js), while their contents
 * change on every release. Version the import URL so a browser cannot keep executing a previous
 * implementation from its long-lived static cache after the server has updated.
 *
 * Safe only because these entries are leaves — nothing imports them back. An ES module's identity
 * is its full URL including the query, so a query on an entry that its own chunks re-import would
 * instantiate it twice; that is what once gave the panel two copies of React (see `vite.config.ts`).
 */
export function adminizerModuleUrl(name: string, version = process.env.GIT_SHA ?? process.env.BUILD_TIME): string {
  const suffix = version ? `?v=${encodeURIComponent(version)}` : '';
  return `/dashboard/modules/${name}.js${suffix}`;
}

/**
 * The stylesheet every Agentiz module needs, passed to the panel as `moduleComponentCSS`.
 *
 * Deliberately unversioned, unlike the module bundles above. Adminizer inserts it as a `<link>`
 * and deduplicates by comparing the path it was given against the links already in `head`
 * (`pages/module.tsx`), and `dist/modules` is served by `serve-static` with no options — so the
 * browser revalidates on every navigation and gets a 304 until the file really changes. Adding a
 * query would gain nothing and give the deduplication a moving target.
 *
 * The `<link>` is global to the document, which is why `agentiz.css` ships no preflight and writes
 * no custom property: it is on every page of the panel the moment one of our screens is opened.
 */
export function adminizerModuleStylesheet(): string {
  return '/dashboard/modules/agentiz.css';
}
