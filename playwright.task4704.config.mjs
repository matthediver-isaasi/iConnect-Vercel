import base from "./playwright.config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...base,
  testDir: "./tests",
  testMatch: /direct-debit-plans-export\.spec\.mjs/,
  outputDir: "test-results/task-4704-direct-debit-plans-export",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  use: {
    ...base.use,
    baseURL: "http://127.0.0.1:5000",
    acceptDownloads: true,
    screenshot: "only-on-failure",
  },
});