import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /department-selector-builder\.spec\.mjs/,
  outputDir: '../generated-artifacts/department-selector-builder',
  timeout: 90_000,
  workers: 1,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5000',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium' },
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
});
