import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: /dd-swap\.spec\.mjs/,
  outputDir: '/tmp/dd-swap-browser', workers: 1, timeout: 90000,
  use: { baseURL: 'http://127.0.0.1:5000', headless: true, serviceWorkers: 'block',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
});
