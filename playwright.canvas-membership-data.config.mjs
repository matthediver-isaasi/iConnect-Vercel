import base from "./playwright.config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...base,
  // Task 4511 uses a fully intercepted browser fixture. Keep its screenshots,
  // traces and report data separate from every other focused Canvas suite.
  outputDir: "test-results/canvas-membership-data",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  testDir: "./tests",
  testMatch: /canvas-membership-data\.spec\.mjs/,
  use: {
    ...base.use,
    screenshot: "only-on-failure",
  },
});