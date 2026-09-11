import base from "./playwright.config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...base,
  outputDir: "test-results/task4377-history",
  timeout: 120_000,
  testDir: "./tests",
  testMatch: /task-4377-history\.spec\.mjs/,
  use: {
    ...base.use,
    screenshot: "only-on-failure",
  },
});