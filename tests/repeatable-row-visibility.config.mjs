import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'repeatable-row-visibility.spec.mjs',
  outputDir: '../test-results/repeatable-row-visibility',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL
      || `https://${process.env.REPLIT_DEV_DOMAIN}`,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        || '/nix/store/5afrhwm7zqn1vb7p5z1mc2rkh2grsfgz-ungoogled-chromium-138.0.7204.100/bin/chromium',
    },
    viewport: { width: 1280, height: 960 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});