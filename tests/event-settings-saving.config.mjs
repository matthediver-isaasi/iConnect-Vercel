import { execFileSync } from 'node:child_process';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /event-settings-saving\.spec\.mjs/,
  outputDir: '/tmp/event-settings-saving-results',
  workers: 1,
  use: {
    headless: true,
    viewport: { width: 1280, height: 900 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim() },
  },
});
