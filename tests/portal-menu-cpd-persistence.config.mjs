import { defineConfig } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;

export default defineConfig({
  testDir: ".",
  testMatch: /portal-menu-cpd-persistence\.spec\.mjs/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  use: {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: executablePath ? { executablePath } : {},
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});