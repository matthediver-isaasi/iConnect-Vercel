import { defineConfig } from "@playwright/test";
import base from "./monthly-membership-recovery.config.mjs";

export default defineConfig({
  ...base,
  testMatch: /file-upload-layout\.spec\.mjs/,
  outputDir: "/tmp/file-upload-layout-results",
});