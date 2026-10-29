import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
export default defineConfig({
  testDir: '.', testMatch: 'team-directory.spec.mjs',
  outputDir: '/tmp/team-directory-results', workers: 1, timeout: 60000,
  use: {
    baseURL: 'http://127.0.0.1:5197', viewport: { width: 1280, height: 900 },
    launchOptions: { executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim() },
    trace: 'retain-on-failure',
  },
  webServer: { command: 'cd .. && npx vite --config tests/team-directory.vite.mjs', url: 'http://127.0.0.1:5197/tests/fixtures/team-directory/index.html', reuseExistingServer: true },
});
