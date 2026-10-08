import { defineConfig } from '@playwright/test';
import base from './monthly-membership-recovery.config.mjs';
export default defineConfig({
  ...base,
  testDir: '../client/src/tests',
  testMatch: /form-alerts\.spec\.mjs/,
  outputDir: '/tmp/form-alerts-results',
  use: { ...base.use, baseURL: 'http://127.0.0.1:5000' },
});
