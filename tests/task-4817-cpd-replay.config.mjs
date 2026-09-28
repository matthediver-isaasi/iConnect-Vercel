import { defineConfig } from "@playwright/test";
import base from "./task-4810-cpd-certificate.config.mjs";

export default defineConfig({
  ...base,
  testMatch: /task-4817-cpd-replay\.spec\.mjs/,
  outputDir: "/tmp/task-4817-cpd-replay-results",
});