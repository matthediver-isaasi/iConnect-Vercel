import { defineConfig } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL
  || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "http://127.0.0.1:5000");
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  || process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE
  || undefined;

export default defineConfig({
  testDir: ".",
  testMatch: /member-organisation-group\.spec\.mjs/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  outputDir: "test-results/member-organisation-group",
  use: {
    baseURL,
    headless: true,
    launchOptions: executablePath ? { executablePath } : {},
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});