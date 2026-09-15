import base from "./playwright.config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...base,
  testDir: "./tests",
  testMatch: /task-4422-review-addresses\.spec\.mjs/,
  outputDir: "test-results/task4422-review-addresses",
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