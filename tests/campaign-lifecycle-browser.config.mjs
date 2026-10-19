import { defineConfig } from '@playwright/test';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  || process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: '.',
  testMatch: /campaign-lifecycle-browser\.spec\.mjs/,
  outputDir: '/tmp/campaign-lifecycle-browser/results',
  reporter: [['list'], ['html', { outputFolder: '/tmp/campaign-lifecycle-browser/report', open: 'never' }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  use: {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: executablePath ? { executablePath } : {},
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  }
});
