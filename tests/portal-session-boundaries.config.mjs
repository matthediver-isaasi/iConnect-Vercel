import { defineConfig } from "@playwright/test";
import { execFileSync } from "node:child_process";

export default defineConfig({
  testDir: ".",
  testMatch: /(?:portal-session-boundaries|sidebar-session-role-navigation)\.spec\.mjs/,
  outputDir: "/tmp/portal-session-boundaries-results",
  timeout: 90_000,
  workers: 1,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5000",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        || execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
    },
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
});