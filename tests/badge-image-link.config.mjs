import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /badge-image-link\.spec\.mjs/,
  outputDir: "/tmp/badge-image-link-results",
  workers: 1,
  use: {
    headless: true,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
});