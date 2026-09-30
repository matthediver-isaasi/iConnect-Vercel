import { defineConfig } from '@playwright/test';
import base from './monthly-membership-recovery.config.mjs';

export default defineConfig({
  ...base,
  testMatch: /form-payment-return\.spec\.mjs/,
  outputDir: '/tmp/form-payment-return-results',
});