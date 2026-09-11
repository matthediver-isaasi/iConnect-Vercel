import base from "./playwright.config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...base,
  // Keep this suite's traces, videos, and failure screenshots separate from
  // other agents' browser runs.
  outputDir: "test-results/task4371",
  timeout: 120_000,
  testDir: "./tests",
  testMatch: /form-row-object-discovery\.task4371\.spec\.mjs/,
  use: {
    ...base.use,
    screenshot: "only-on-failure",
  },
});