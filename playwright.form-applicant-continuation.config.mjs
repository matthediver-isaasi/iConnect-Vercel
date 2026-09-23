import { defineConfig } from "@playwright/test";
import base from "./playwright.config.mjs";

export default defineConfig({
  ...base,
  testMatch: /form-applicant-continuation\.spec\.mjs/,
  outputDir: "test-results/form-applicant-continuation",
});