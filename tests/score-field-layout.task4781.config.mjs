import { defineConfig } from "@playwright/test";
import base from "./monthly-membership-recovery.config.mjs";

export default defineConfig({
  ...base,
  testMatch: /score-field-layout\.task4781\.spec\.mjs/,
  outputDir: "/tmp/score-field-layout-task4781-results",
});