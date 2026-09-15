import base from "./playwright.config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...base,
  testDir: "./tests",
  testMatch: /task-4387-member-only-html\.spec\.mjs/,
  outputDir: "test-results/task4387",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    ...base.use,
    screenshot: "only-on-failure",
  },
});