import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'featured-job-preview.spec.mjs',
  outputDir: '../test-results/featured-job-preview',
  reporter: 'list',
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 12_000 },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5000',
    viewport: { width: 1600, height: 1000 },
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
        process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
