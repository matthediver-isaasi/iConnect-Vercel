import base from "./playwright.config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...base,
  // The proxied development build can take a minute to load from a cold start.
  timeout: 120_000,
  testDir: "./tests",
  testMatch: /form-row-choice-cascade\.spec\.mjs/,
});