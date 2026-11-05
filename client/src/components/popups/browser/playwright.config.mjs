import { defineConfig } from "@playwright/test";

// Reuses the running Vite server, as the existing Canvas browser suites do.
// All API requests are intercepted fixtures; no application DB is contacted.
export default defineConfig({
  testDir: ".", testMatch: "popups.browser.spec.mjs",
  outputDir: "../../../../../test-results/cms-popups",
  reporter: "list", workers: 1, timeout: 60000,
  expect: { timeout: 12000 },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5000",
    viewport: { width: 1600, height: 1000 }, headless: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined },
    trace: "retain-on-failure", screenshot: "only-on-failure",
  },
});
