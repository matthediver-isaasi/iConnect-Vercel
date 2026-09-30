import { defineConfig } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;

export default defineConfig({
  testDir: "./tests",
  testMatch: /task-4575-(?:public-invoice-po|editor-routes)\.spec\.mjs/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  outputDir: "test-results/task-4575-browser",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5000",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: executablePath ? { executablePath } : {},
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});