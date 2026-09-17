import { defineConfig } from '@playwright/test';

const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  || '/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium';

export default defineConfig({
  testDir: '.',
  testMatch: /department-current-set\.spec\.mjs/,
  outputDir: '../test-results/department-current-set',
  timeout: 90_000,
  expect: { timeout: 12_000 },
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5000',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: { executablePath: chromiumExecutable },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});