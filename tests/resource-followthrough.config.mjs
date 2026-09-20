import { defineConfig } from '@playwright/test';
import base from './monthly-membership-recovery.config.mjs';

export default defineConfig({
  ...base,
  testMatch: /resource-followthrough\.spec\.mjs/,
  outputDir: '/tmp/resource-followthrough-results',
});