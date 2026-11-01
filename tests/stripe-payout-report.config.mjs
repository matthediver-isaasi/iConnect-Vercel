import { execFileSync } from 'node:child_process';
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: /stripe-payout-report\.spec\.mjs/,
  outputDir: '../generated-artifacts/payout-browser', workers: 1, timeout: 90000,
  webServer: { cwd: new URL('..', import.meta.url).pathname, command: 'npx vite --config tests/payment-report.vite.config.mjs',
    url: 'http://127.0.0.1:5189', reuseExistingServer: false, timeout: 120000 },
  use: { baseURL: 'http://127.0.0.1:5189', headless: true,
    launchOptions: { executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim() },
    viewport: { width: 1440, height: 1050 } },
});
