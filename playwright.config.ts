import { defineConfig } from '@playwright/test';

// In CI the browser comes from `npx playwright install chromium`.
// Elsewhere PW_CHROMIUM_PATH can point at a preinstalled Chromium.
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  retries: 0,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    launchOptions: executablePath ? { executablePath } : {},
  },
});
