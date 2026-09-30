import base from "./playwright.config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...base,
  testDir: "./tests",
  testMatch: /task-4426-event-clicks\.spec\.mjs/,
  outputDir: "test-results/task4426-event-clicks",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  use: {
    ...base.use,
    screenshot: "only-on-failure",
  },
});