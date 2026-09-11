import base from "./playwright.config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...base,
  outputDir: "test-results/task4378",
  timeout: 120_000,
  testDir: "./tests",
  testMatch: /form-row-object-discovery\.task4378\.spec\.mjs/,
  use: {
    ...base.use,
    screenshot: "only-on-failure",
  },
});