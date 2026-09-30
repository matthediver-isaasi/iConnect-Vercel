import baseConfig from "./monthly-membership-recovery.config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...baseConfig,
  testDir: ".",
  testMatch: /stripe-membership-webhooks\.spec\.mjs/,
  outputDir: "/tmp/stripe-membership-webhooks-results",
});