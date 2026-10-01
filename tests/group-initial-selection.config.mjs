import { defineConfig } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL
  || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "http://127.0.0.1:5000");
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  || process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE
  || undefined;

// Uses the already-running preview; deliberately does not start a web server.
export default defineConfig({
  testDir: ".",
  testMatch: /group-initial-selection\.spec\.mjs$/,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  outputDir: "test-results/group-initial-selection",
  use: {
    baseURL,
    headless: true,
    serviceWorkers: "block",
    launchOptions: executablePath ? { executablePath } : {},
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});