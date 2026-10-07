import { defineConfig } from "@playwright/test";
import base from "../../../tests/task-4810-cpd-certificate.config.mjs";

export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: /form-alerts\.spec\.mjs/,
  outputDir: "/tmp/form-alert-admin-results",
  reporter: "list",
  retries: 0,
});
