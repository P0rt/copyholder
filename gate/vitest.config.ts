// Local Vitest config for the gate packs until the root vitest.config.ts includes gate/**
// (review 6): npx vitest run --config gate/vitest.config.ts gate/check-texts.test.ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    include: ['gate/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    maxWorkers: 2,
  },
});
