import base from './playwright.config.mjs';
import { defineConfig } from '@playwright/test';
export default defineConfig({
  ...base, testMatch: /history-clarity\.spec\.mjs/,
  outputDir: 'generated-artifacts/mandate-browser',
});
