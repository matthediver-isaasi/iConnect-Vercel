import { defineConfig } from "@playwright/test";
import { execFileSync } from "node:child_process";

export default defineConfig({
  testDir: ".",
  testMatch: /speaker-badge-events\.spec\.mjs/,
  outputDir: "../generated-artifacts/speaker-badge-events",
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: "http://127.0.0.1:5000",
    headless: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || execFileSync("which", ["chromium"], { encoding: "utf8" }).trim() },
    screenshot: "only-on-failure",
  },
});
