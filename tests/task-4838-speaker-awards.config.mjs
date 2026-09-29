import { defineConfig } from "@playwright/test";
import browserConfig from "./task-4810-cpd-certificate.config.mjs";

export default defineConfig({
  ...browserConfig,
  testMatch: /task-4838-speaker-awards\.spec\.mjs/,
  outputDir: "/tmp/task-4838-speaker-awards-results",
  use: { ...browserConfig.use, baseURL: "http://speaker-awards.fixture" },
});