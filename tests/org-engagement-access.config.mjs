import { defineConfig } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;

export default defineConfig({
  testDir: ".",
  testMatch: /org-engagement-access\.spec\.mjs/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  use: {
    headless: true,
    viewport: { width: 1280, height: 900 },
    launchOptions: executablePath ? { executablePath } : {},
    screenshot: "only-on-failure",
  },
});