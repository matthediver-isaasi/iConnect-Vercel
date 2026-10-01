import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /event-invoice-recovery\.spec\.mjs/,
  outputDir: "../test-results/event-invoice-recovery",
  timeout: 120000,
  workers: 1,
  use: {
    headless: true,
    viewport: { width: 1280, height: 1000 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined },
    screenshot: "only-on-failure",
  },
});