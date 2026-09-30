import { defineConfig } from "@playwright/test";
import base from "./playwright.task4782.config.mjs";

export default defineConfig({
  ...base,
  testMatch: /task-4880-member-email\.spec\.mjs/,
  outputDir: "test-results/task4880-member-email",
});