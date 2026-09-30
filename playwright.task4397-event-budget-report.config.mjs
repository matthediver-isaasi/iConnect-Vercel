import base from "./playwright.config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...base,
  testDir: "./tests",
  testMatch: /task-4397-event-budget-report\.spec\.mjs/,
  outputDir: "test-results/task4397-event-budget-report",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    ...base.use,
    screenshot: "only-on-failure",
  },
});