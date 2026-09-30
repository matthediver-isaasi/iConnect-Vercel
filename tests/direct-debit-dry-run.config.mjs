import { defineConfig } from "@playwright/test";
import base from "./monthly-membership-recovery.config.mjs";

export default defineConfig({
  ...base,
  testMatch: /direct-debit-dry-run\.spec\.mjs/,
  outputDir: "/tmp/direct-debit-dry-run-results",
});