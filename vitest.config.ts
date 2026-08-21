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
    include: [
      'smoke.test.ts',
      'layers/app-agentiz/**/*.{test,spec}.{ts,tsx}',
      'layers/app-agentiz-mobile-api/**/*.{test,spec}.{ts,tsx}',
      'layers/app-agentiz-claude-limits/**/*.{test,spec}.{ts,tsx}',
    ],
  },
});
