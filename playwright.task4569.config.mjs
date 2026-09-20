import base from "./playwright.config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...base,
  testDir: "./tests",
  testMatch: /task-4569-microsite-logo-destination\.spec\.mjs/,
  outputDir: "test-results/task-4569-microsite-logo-destination",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  use: {
    ...base.use,
    screenshot: "only-on-failure",
  },
});