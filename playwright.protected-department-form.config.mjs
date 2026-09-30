import { defineConfig } from '@playwright/test';
import base from './playwright.config.mjs';

export default defineConfig({
  ...base,
  testMatch: /protected-department-form\.spec\.mjs/,
  outputDir: 'test-results/protected-department-form',
});