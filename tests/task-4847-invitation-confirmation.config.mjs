import { defineConfig } from '@playwright/test';
import base from './task-4810-cpd-certificate.config.mjs';

export default defineConfig({
  ...base,
  testMatch: /task-4847-invitation-confirmation\.spec\.mjs/,
  outputDir: '/tmp/task-4847-invitation-confirmation-results',
});