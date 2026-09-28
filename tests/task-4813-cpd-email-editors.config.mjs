import { defineConfig } from "@playwright/test";
import base from "./task-4810-cpd-certificate.config.mjs";

export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: /task-4813-cpd-email-editors\.spec\.mjs/,
  outputDir: "/tmp/task-4813-cpd-email-editors-results",
  use: {
    ...base.use,
    baseURL: "http://cpd-email-editors.test",
  },
});