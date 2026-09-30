import { defineConfig } from "@playwright/test";
import { execFileSync } from "node:child_process";

export default defineConfig({
  testDir: ".",
  testMatch: /portal-lifecycle-comparison\.spec\.mjs/,
  outputDir: "/tmp/portal-lifecycle-comparison-results",
  timeout: 300_000,
  workers: 1,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5000",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        || execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
    },
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
});