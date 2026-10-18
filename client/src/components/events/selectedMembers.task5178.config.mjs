import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';

// Bundled components and intercepted fixtures only: never starts the app.
export default defineConfig({
  testDir: '.',
  testMatch: 'selectedMembers.task5178.spec.mjs',
  workers: 1,
  outputDir: '/tmp/selected-members-task5178-results',
  use: {
    browserName: 'chromium',
    headless: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim() },
  },
});
