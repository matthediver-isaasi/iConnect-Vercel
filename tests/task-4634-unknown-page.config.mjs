import { execFileSync } from 'node:child_process';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /task-4634-unknown-page\.spec\.mjs/,
  outputDir: '/tmp/task-4634-results',
  workers: 1,
  use: {
    headless: true,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
        execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(),
    },
  },
});