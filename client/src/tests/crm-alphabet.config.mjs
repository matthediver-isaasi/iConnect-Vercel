import { defineConfig } from '@playwright/test';
import base from '../../../playwright.config.mjs';

export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: /crm-alphabet\.spec\.mjs/,
  outputDir: '../../../test-results/crm-alphabet',
});
