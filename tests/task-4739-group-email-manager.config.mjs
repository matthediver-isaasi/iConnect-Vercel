import base from "../playwright.config.mjs";
import { defineConfig } from "@playwright/test";

// The test serves an intercepted in-memory page, so it never contacts the
// application, database, or email provider.
export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: /task-4739-group-email-manager\.spec\.mjs/,
  outputDir: "../test-results/task-4739-group-email-manager",
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  use: {
    ...base.use,
    baseURL: "https://task4739.fixture.invalid",
    screenshot: "on",
  },
});