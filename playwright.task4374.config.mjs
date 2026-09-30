import base from "./playwright.config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...base,
  // Keep the Canvas Dynamic Widget run isolated from the repository's other
  // focused browser suites.
  outputDir: "test-results/task4374",
  timeout: 120_000,
  testDir: "./tests",
  testMatch: /task-4374-canvas-dynamic-widget\.spec\.mjs/,
  use: {
    ...base.use,
    screenshot: "only-on-failure",
  },
});