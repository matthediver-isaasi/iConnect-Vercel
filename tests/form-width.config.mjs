import { defineConfig } from "@playwright/test";
import base from "./monthly-membership-recovery.config.mjs";

export default defineConfig({
  ...base,
  testMatch: /form-width\.spec\.mjs/,
  outputDir: "/tmp/form-width-results",
});