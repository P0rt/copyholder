import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'core/**/*.test.ts',
      'analysis/**/*.test.ts',
      'planter/**/*.test.ts',
      'tools/**/*.test.ts',
      'web/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    exclude: ['tests/e2e/**', 'node_modules/**', 'live/node_modules/**'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
