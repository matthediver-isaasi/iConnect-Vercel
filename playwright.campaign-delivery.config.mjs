import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: 'campaign-lifecycle-browser.spec.mjs',
  outputDir: '/tmp/campaign-delivery-playwright',
  workers: 1,
  use: { browserName: 'chromium', headless: true, viewport: { width: 1440, height: 1000 },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {} },
});
