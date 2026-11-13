import { defineConfig } from '@playwright/test';

// In CI the browser comes from `npx playwright install chromium`.
// Elsewhere PW_CHROMIUM_PATH can point at a preinstalled Chromium.
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

// tests/e2e/integration.spec.ts runs the whole live chain in real time (about 10 minutes, more with
// @slow): only `npm run test:integration` runs it, not `npm test` or CI.
const live = process.env.COPYHOLDER_E2E_LIVE === '1';

export default defineConfig({
  testDir: 'tests/e2e',
  testIgnore: live ? [] : ['**/integration.spec.ts'],
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    launchOptions: executablePath ? { executablePath } : {},
  },
});
