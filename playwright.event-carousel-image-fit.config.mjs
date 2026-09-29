import base from "./playwright.config.mjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...base,
  testDir: "./tests",
  testMatch: /event-carousel-image-fit\.spec\.mjs/,
  outputDir: "/tmp/event-carousel-image-fit-results",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  use: { ...base.use, screenshot: "only-on-failure" },
});