import { defineConfig } from "@playwright/test";
import base from "./playwright.config.mjs";

export default defineConfig({
  ...base,
  outputDir: "test-results/events-widgets",
  timeout: 120_000,
  testDir: "./tests",
  testMatch: /events-widgets-cache\.spec\.mjs/,
  use: {
    ...base.use,
    screenshot: "only-on-failure",
  },
});