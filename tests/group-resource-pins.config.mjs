import { defineConfig } from '@playwright/test';
import base from './monthly-membership-recovery.config.mjs';
export default defineConfig({
  ...base,
  testMatch: /group-resource-pins\.spec\.mjs/,
  outputDir: '/tmp/group-resource-pins-results',
});
