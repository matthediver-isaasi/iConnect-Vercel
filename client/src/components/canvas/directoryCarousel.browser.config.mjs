import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /directoryCarousel\.browser\.mjs/,
  outputDir: '/tmp/directory-carousel-task5186-results',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5000',
    headless: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE },
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
  },
});
