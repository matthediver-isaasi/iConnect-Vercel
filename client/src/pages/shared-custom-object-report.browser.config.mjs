import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import base from '../../../playwright.config.mjs';
export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: 'shared-custom-object-report.browser.spec.mjs',
  outputDir: '../../../generated-artifacts/shared-report-browser',
  fullyParallel: false,
  workers: 1,
  use: { ...base.use, baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5000',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
      execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim() } },
});
