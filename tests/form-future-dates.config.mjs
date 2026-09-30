import { defineConfig } from "@playwright/test";
import base from "./monthly-membership-recovery.config.mjs";

export default defineConfig({
  ...base,
  testMatch: /form-future-dates\.spec\.mjs/,
  outputDir: "/tmp/form-future-dates-results",
  use: {
    ...base.use,
    // Keep the browser on the previous local calendar day while the fixture
    // clock is late in a UTC day. This catches implementations that use local
    // date parts instead of the required UTC date-only boundary.
    timezoneId: "Pacific/Honolulu",
    screenshot: "only-on-failure",
  },
});