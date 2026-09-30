import { defineConfig } from "@playwright/test";
import { execFileSync } from "node:child_process";

const baseURL = process.env.PLAYWRIGHT_BASE_URL
  || (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "http://127.0.0.1:5000");
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (() => {
  try {
    return execFileSync("which", ["chromium"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
})();

export default defineConfig({
  testDir: "./tests",
  testMatch: /task-4570-form-success-reveal\.spec\.mjs/,
  outputDir: "test-results/task-4570-form-success-reveal",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL,
    headless: true,
    launchOptions: chromiumExecutable
      ? { executablePath: chromiumExecutable }
      : undefined,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});