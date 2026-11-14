import { defineConfig } from "@playwright/test";
import base from "./task-4810-cpd-certificate.config.mjs";
export default defineConfig({
  ...base, testMatch: /speaker-order\.spec\.mjs/,
  outputDir: "/tmp/speaker-order-results",
});
