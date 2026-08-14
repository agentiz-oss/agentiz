/**
 * Vite's custom module entry names are stable (for example AgentizRunDetail.js), while their
 * contents change on every release. Version the import URL so a browser cannot keep executing a
 * previous form implementation from its long-lived static cache after the server has updated.
 */
export function adminizerModuleUrl(name: string, version = process.env.GIT_SHA ?? process.env.BUILD_TIME): string {
  const suffix = version ? `?v=${encodeURIComponent(version)}` : '';
  return `/dashboard/modules/${name}.js${suffix}`;
}
