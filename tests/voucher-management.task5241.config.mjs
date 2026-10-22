import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';

export default defineConfig({
  testDir: '.',
  testMatch: 'voucher-management.task5241.spec.mjs',
  outputDir: '/tmp/voucher-task5241-browser-results',
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:5000',
    viewport: { width: 1440, height: 1000 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim() },
    trace: 'retain-on-failure',
  },
});
