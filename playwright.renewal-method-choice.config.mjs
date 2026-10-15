import { defineConfig } from '@playwright/test';
import base from './playwright.task4782.config.mjs';

export default defineConfig({
  testDir: './tests',
  testMatch: 'renewal-method-choice.spec.mjs',
  workers: 1,
  use: { ...base.use, baseURL: 'http://127.0.0.1:5000', headless: true },
  outputDir: 'generated-artifacts/renewal-method-choice',
});
