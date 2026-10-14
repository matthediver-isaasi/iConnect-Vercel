import { execFileSync } from "node:child_process";
import { defineConfig } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL
  || (process.env.PAYMENT_REPORT_ISOLATED ? "http://127.0.0.1:5189" : null)
  || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "http://127.0.0.1:5000");
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  || execFileSync("which", ["chromium"], { encoding: "utf8" }).trim();

export default defineConfig({
  testDir: ".",
  testMatch: /payment-report\.spec\.mjs/,
  outputDir: "/tmp/payment-report-results",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  webServer: process.env.PAYMENT_REPORT_ISOLATED ? {
    cwd: new URL("..", import.meta.url).pathname,
    command: "npx vite --config tests/payment-report.vite.config.mjs",
    url: "http://127.0.0.1:5189",
    reuseExistingServer: false,
    timeout: 120_000,
  } : undefined,
  use: {
    baseURL,
    headless: true,
    launchOptions: { executablePath },
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});