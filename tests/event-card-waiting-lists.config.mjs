import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
export default defineConfig({
  testDir: '.', testMatch: /event-card-waiting-lists\.spec\.mjs/,
  outputDir: '/tmp/event-card-waiting-lists-results', workers: 1, timeout: 60000,
  use: { headless: true, viewport: { width: 1400, height: 1000 }, launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(),
  } },
});
