import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'smoke.test.ts',
      'layers/app-agentiz/**/*.{test,spec}.{ts,tsx}',
      'layers/app-agentiz-mobile-api/**/*.{test,spec}.{ts,tsx}',
      'layers/app-agentiz-claude-limits/**/*.{test,spec}.{ts,tsx}',
    ],
  },
});
