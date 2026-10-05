import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';

if (process.env.BNMS_DISPOSABLE_ACCEPTANCE !== '1') {
  throw new Error('Use node scripts/run-bnms-renewal-acceptance.mjs to strip workspace credentials.');
}

export default defineConfig({
  testDir: '.', testMatch: 'bnms-renewal-acceptance.spec.mjs',
  outputDir: '/tmp/bnms-renewal-acceptance-results',
  workers: 1, timeout: 120000,
  use: {
    baseURL: 'http://127.0.0.1:5195',
    launchOptions: { executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim() },
    serviceWorkers: 'block', screenshot: 'only-on-failure',
  },
});
