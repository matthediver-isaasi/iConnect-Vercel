import { defineConfig } from "@playwright/test";
import base from "./monthly-membership-recovery.config.mjs";
export default defineConfig({
  ...base,
  testMatch: /survey-assignment-layout\.spec\.mjs/,
  outputDir: "/tmp/survey-assignment-layout-results",
  use: { ...base.use, baseURL: "http://127.0.0.1:5188" },
  webServer: {
    cwd: process.cwd(),
    command: "node tests/fixtures/survey-assignment-layout/server.mjs",
    url: "http://127.0.0.1:5188",
    reuseExistingServer: !process.env.CI,
  },
});
