import base from "./playwright.config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...base,
  outputDir: "test-results/task610",
  timeout: 120_000,
  testDir: "./tests",
  testMatch: /task-610-dashboard-widget-cache\.spec\.mjs/,
  use: {
    ...base.use,
    screenshot: "only-on-failure",
  },
});