import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: /campaign-unsaved-browser\.spec\.mjs/,
  outputDir: '/tmp/campaign-unsaved/results', reporter: 'list',
  workers: 1, timeout: 60000, expect: { timeout: 10000 },
  use: { headless: true, viewport: { width: 1440, height: 1000 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      || process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined },
    trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
