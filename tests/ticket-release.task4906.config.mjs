import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';

// Bundled component fixtures only: no application server or live APIs.
export default defineConfig({
  testDir: '.',
  testMatch: 'ticket-release.task4906.spec.mjs',
  workers: 1,
  outputDir: '/tmp/ticket-release-task4906-results',
  use: {
    browserName: 'chromium', headless: true,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(),
    },
  },
});