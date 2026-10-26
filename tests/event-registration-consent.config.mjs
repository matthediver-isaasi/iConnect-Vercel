import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
export default defineConfig({
  testDir: '.', testMatch: /event-registration-consent\.spec\.mjs/,
  outputDir: '/tmp/event-registration-consent-results',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5189',
    launchOptions: { executablePath: execFileSync('which',['chromium'],{encoding:'utf8'}).trim() },
  },
  webServer: {
    cwd: new URL('..', import.meta.url).pathname,
    command: 'npx vite --config tests/event-registration-consent.vite.mjs',
    url: 'http://127.0.0.1:5189/tests/fixtures/event-registration-consent.html',
    reuseExistingServer: false,
  },
});
