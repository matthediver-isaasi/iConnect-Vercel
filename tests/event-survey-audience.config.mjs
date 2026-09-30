import { defineConfig } from "@playwright/test";
import base from "./audience-list-preview.config.mjs";

export default defineConfig({
  ...base,
  testMatch: /event-survey-audience\.spec\.mjs/,
  outputDir: "/tmp/event-survey-audience-results",
});