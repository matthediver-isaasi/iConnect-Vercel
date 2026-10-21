import { defineConfig } from "@playwright/test";

// Use an already-running Vite preview; no real API or provider is used.
export default defineConfig({
  testDir: ".",
  testMatch: /badge-instructions\.spec\.mjs/,
  outputDir: "/tmp/badge-instructions-results",
  workers: 1,
  use: {
    baseURL: process.env.BADGE_FIXTURE_BASE_URL || "http://127.0.0.1:5000",
    viewport: { width: 1280, height: 900 },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
});
