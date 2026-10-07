import { defineConfig } from '@playwright/test';
import base from './monthly-membership-recovery.config.mjs';
export default defineConfig({
  ...base,
  testMatch: /member-group-custom-fields\.spec\.mjs/,
  outputDir: '/tmp/member-group-custom-fields-results',
});
