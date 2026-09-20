import { defineConfig } from "@playwright/test";
import { execFileSync } from "node:child_process";

export default defineConfig({
  testDir: ".",
  testMatch: /articles-sidebar\.spec\.mjs/,
  outputDir: "/tmp/articles-sidebar-results",
  workers: 1,
  use: {
    headless: true,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        || execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
    },
  },
});