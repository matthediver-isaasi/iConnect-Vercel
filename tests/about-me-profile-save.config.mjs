import { defineConfig } from "@playwright/test";
import { execFileSync } from "node:child_process";

export default defineConfig({
  testDir: ".",
  testMatch: /about-me-profile-save\.spec\.mjs/,
  outputDir: "/tmp/about-me-profile-save-results",
  workers: 1,
  timeout: 90_000,
  use: {
    baseURL: "http://127.0.0.1:5000",
    viewport: { width: 1280, height: 900 },
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        || execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
    },
    trace: "retain-on-failure",
  },
});