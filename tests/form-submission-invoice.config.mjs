import { defineConfig } from '@playwright/test';
import base from './form-submission-delete.config.mjs';

export default defineConfig({
  ...base,
  testMatch: 'form-submission-invoice.spec.mjs',
  outputDir: '/tmp/form-submission-invoice-results',
});
