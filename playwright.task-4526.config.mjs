import { defineConfig } from "@playwright/test";
import previous from "./playwright.embed-form-page-transitions.config.mjs";

export default defineConfig({
  ...previous,
  testMatch: /task-4526-form-pickers\.spec\.mjs/,
  outputDir: process.env.PICKER_BASELINE === "1"
    ? "test-results/task-4526-picker-baseline"
    : "test-results/task-4526-form-pickers",
  timeout: 120_000,
  use: {
    ...previous.use,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        || "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium",
    },
  },
});