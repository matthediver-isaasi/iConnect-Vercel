import baseConfig from "./playwright.config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...baseConfig,
  testMatch: /stripe-address-mappings\.smoke\.spec\.mjs/,
});