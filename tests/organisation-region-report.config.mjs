import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "organisation-region-report.spec.mjs",
  outputDir: "../test-results/organisation-region-report",
  workers: 1,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5000",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        || process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    },
    viewport: { width: 1280, height: 1000 },
  },
});
