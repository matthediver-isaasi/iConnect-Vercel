import { defineConfig } from "@playwright/test";
import { execFileSync } from "node:child_process";
import base from "../playwright.config.mjs";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  || execFileSync("which", ["chromium"], { encoding: "utf8" }).trim();

export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: /task-4804-certificate-preview\.spec\.mjs/,
  outputDir: "/tmp/task-4804-certificate-preview-results",
  workers: 1,
  fullyParallel: false,
  use: {
    ...base.use,
    viewport: { width: 1440, height: 900 },
    launchOptions: { executablePath },
    screenshot: "on",
  },
});