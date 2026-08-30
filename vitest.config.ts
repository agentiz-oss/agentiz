import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // `local_modules/app-workflow` carries its own (older) copy of app-manager, whose ESM entry
      // uses extensionless imports. tsx tolerates those, Vite's resolver does not — so a test that
      // touches the workflow engine would die on `Cannot find module .../lib/AppManager`. Point
      // every copy at the one the app itself runs on.
      '@nodeknit/app-manager': path.resolve(__dirname, 'local_modules/app-manager'),
    },
  },
  test: {
    // `adminizer` is ESM with a directory import inside (system/bindDocs → controllers/docs).
    // tsx resolves that, Node's ESM loader does not — so the package has to go through Vite's
    // resolver instead of being externalised, or importing it from a test dies on collection.
    server: { deps: { inline: ['adminizer'] } },
    include: [
      'smoke.test.ts',
      'layers/app-agentiz/**/*.{test,spec}.{ts,tsx}',
      'layers/app-agentiz-mobile-api/**/*.{test,spec}.{ts,tsx}',
      'layers/app-agentiz-claude-limits/**/*.{test,spec}.{ts,tsx}',
      // app-adminizer is a package of its own, but it is developed from this checkout and carries
      // no test runner — run its tests with ours so `npm test` covers the seam the panel uses.
      'local_modules/app-adminizer/tests/**/*.{test,spec}.ts',
      // Same reason for app-workflow: the engine is developed from this checkout and ships no
      // runner of its own, so its tests run with ours.
      'local_modules/app-workflow/tests/**/*.{test,spec}.ts',
    ],
  },
});
