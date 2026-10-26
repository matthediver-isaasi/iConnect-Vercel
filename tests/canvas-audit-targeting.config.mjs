import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: 'canvas-audit-targeting.spec.mjs',
  outputDir: '../test-results/canvas-audit-targeting', workers: 1,
  timeout: 60000,
  use: { baseURL: 'http://127.0.0.1:5000', viewport: { width: 1600, height: 1000 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE } },
});
