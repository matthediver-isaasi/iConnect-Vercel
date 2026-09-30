import { defineConfig } from '@playwright/test';
import base from './monthly-membership-recovery.config.mjs';

export default defineConfig({
  ...base,
  testMatch: /resource-release\.task4691\.spec\.mjs/,
  outputDir: '/tmp/resource-release-task4691-results',
});