import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "related-record-report-filters.spec.mjs",
  outputDir: "../test-results/related-record-report-filters",
  workers: 1,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || `https://${process.env.REPLIT_DEV_DOMAIN}`,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
    viewport: { width: 1280, height: 1000 },
  },
});