import base from "./playwright.task4387.config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...base,
  grep: /BNMS |header ordinary login|explicit contextual login|LoginForm rejects/,
  outputDir: "test-results/bnms-role-login",
  use: {
    ...base.use,
    // An isolated origin avoids tenant-subdomain detection replacing the
    // fixture slug, which would make BNMS assertions test a different tenant.
    baseURL: "http://127.0.0.1:5000",
  },
});