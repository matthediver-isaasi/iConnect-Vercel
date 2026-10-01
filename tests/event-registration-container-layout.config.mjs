import { execFileSync } from "node:child_process";
import { defineConfig } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  || execFileSync("which", ["chromium"], { encoding: "utf8" }).trim();

export default defineConfig({
  testDir: ".",
  testMatch: /event-registration-container-layout\.spec\.mjs/,
  outputDir: "/tmp/event-registration-container-layout-results",
  timeout: 90_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    headless: true,
    launchOptions: { executablePath },
    viewport: { width: 1440, height: 900 },
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});