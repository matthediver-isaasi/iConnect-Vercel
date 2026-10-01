import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'canvas-symbol-content.task4903.spec.mjs',
  outputDir: '../test-results/canvas-symbol-content-task4903',
  reporter: [['list'], ['json', { outputFile: 'test-results/canvas-symbol-content-task4903/report.json' }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5000',
    viewport: { width: 1600, height: 1050 },
    headless: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});