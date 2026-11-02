import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: 'canvas-seo-suggestions.spec.mjs',
  outputDir: '../test-results/canvas-seo-suggestions',
  reporter: 'list', workers: 1, timeout: 90000,
  use: {
    baseURL: 'http://127.0.0.1:5000', viewport: { width: 1280, height: 1000 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined },
  },
});
