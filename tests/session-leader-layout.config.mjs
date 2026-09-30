import { defineConfig } from "@playwright/test";
import base from "./monthly-membership-recovery.config.mjs";

export default defineConfig({
  ...base,
  testMatch: /session-leader-layout\.spec\.mjs/,
  outputDir: "/tmp/session-leader-layout-results",
  use: { ...base.use, hasTouch: true },
});