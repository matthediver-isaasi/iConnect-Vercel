import base from "./playwright.config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...base,
  testDir: "./tests",
  testMatch: /(?:task-4377-history|history-clarity)\.spec\.mjs/,
  outputDir: "test-results/history-clarity",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  use: {
    ...base.use,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
  },
});