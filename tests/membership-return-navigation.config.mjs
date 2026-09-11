import { defineConfig } from "@playwright/test";
import base from "./monthly-membership-recovery.config.mjs";

export default defineConfig({
  ...base,
  testMatch: /membership-return-navigation\.spec\.mjs/,
  // Do not share artifacts with the payment-return or recovery suites: the
  // suites are often run concurrently while return-flow work is in progress.
  outputDir: "/tmp/membership-return-navigation-results",
  use: {
    ...base.use,
    screenshot: "only-on-failure",
  },
});