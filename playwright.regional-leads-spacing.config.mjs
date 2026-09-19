import base from "./playwright.config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...base,
  testDir: "./tests",
  testMatch: /regional-leads-spacing\.spec\.mjs/,
  outputDir: "test-results/regional-leads-spacing",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    ...base.use,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});