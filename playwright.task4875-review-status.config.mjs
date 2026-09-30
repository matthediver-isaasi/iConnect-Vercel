import base from "./playwright.config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...base,
  testMatch: /task-4875-review-status\.spec\.mjs/,
  outputDir: "test-results/task4875-review-status",
});