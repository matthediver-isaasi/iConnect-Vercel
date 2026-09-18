import base from "./playwright.config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...base,
  testDir: "./tests",
  testMatch: /member-organisation-list-loading\.spec\.mjs/,
  outputDir: "test-results/task4507-list-loading",
  timeout: 90_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    ...base.use,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
  },
});