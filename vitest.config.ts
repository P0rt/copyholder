import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['core/**/*.test.ts', 'analysis/**/*.test.ts', 'planter/**/*.test.ts', 'tools/**/*.test.ts', 'tests/unit/**/*.test.ts', 'web/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
