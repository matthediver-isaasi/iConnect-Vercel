import base from "./playwright.config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...base,
  testDir: "./tests",
  testMatch: /task-4423-review-stage-action-results\.spec\.mjs/,
  outputDir: "test-results/task4423-review-stage-action-results",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  use: {
    ...base.use,
    screenshot: "only-on-failure",
  },
});