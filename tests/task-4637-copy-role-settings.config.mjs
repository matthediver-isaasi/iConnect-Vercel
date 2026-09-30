import { execFileSync } from "node:child_process";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /task-4637-copy-role-settings\.spec\.mjs/,
  outputDir: "/tmp/task-4637-copy-role-settings-results",
  workers: 1,
  use: {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
        execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
    },
  },
});