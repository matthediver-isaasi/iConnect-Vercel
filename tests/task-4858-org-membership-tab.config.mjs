import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /task-4858-org-membership-tab\.spec\.mjs/,
  outputDir: '../test-results/task-4858-org-membership-tab',
  workers: 1,
  timeout: 60000,
  use: {
    headless: true,
    viewport: { width: 1100, height: 900 },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
});