import { defineConfig } from "@playwright/test";
import base from "./portal-session-boundaries.config.mjs";

export default defineConfig({
  ...base,
  testMatch: /publication-import\.spec\.mjs/,
  outputDir: "/tmp/publication-import-results",
  timeout: 60_000,
  expect: { timeout: 12_000 },
  reporter: "list",
});
