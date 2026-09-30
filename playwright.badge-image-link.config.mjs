import base from "./playwright.config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...base,
  testMatch: /badge-image-link\.spec\.mjs/,
  outputDir: "test-results/badge-image-link",
});