import base from "./playwright.config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...base,
  outputDir: "test-results/task4508",
  testMatch: /task-4508-canvas-member-text\.spec\.mjs/,
  timeout: 120_000,
});