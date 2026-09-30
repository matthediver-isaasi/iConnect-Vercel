import { defineConfig } from '@playwright/test';
import base from '../playwright.config.mjs';
export default defineConfig({
  ...base,
  testDir: '.', testMatch: /campaign-event-survey\.spec\.mjs/,
  workers: 1, use: { ...base.use, headless: true },
});