import { defineConfig } from '@playwright/test';
import base from './form-submissions-csv.config.mjs';

export default defineConfig({
  ...base,
  testMatch: 'form-submission-delete.spec.mjs',
  outputDir: '/tmp/form-submission-delete-results',
  use: { ...base.use, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' },
});
