import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
export default defineConfig({
  testDir: '.', testMatch: 'layout-fonts.spec.mjs', workers: 1, timeout: 60000,
  outputDir: '/tmp/layout-font-results',
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5002',
    viewport: { width: 1440, height: 900 },
    launchOptions: { executablePath: execFileSync('which', ['chromium']).toString().trim() } },
});
