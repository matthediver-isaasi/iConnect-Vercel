import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: /campaign-pdf\.spec\.mjs/,
  outputDir: '/tmp/campaign-pdf-results', workers: 1, timeout: 90000,
  use: { headless: true, viewport: { width: 1440, height: 1000 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined } },
});
