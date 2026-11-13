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
      'gate/**/*.test.ts',
    ],
    exclude: ['tests/e2e/**', 'node_modules/**', 'live/node_modules/**'],
    environment: 'node',
    testTimeout: 30_000,
    // Several test runs can share one small machine: keep each run light.
    maxWorkers: 2,
  },
});
