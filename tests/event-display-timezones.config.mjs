import { defineConfig } from '@playwright/test';
import base from './monthly-membership-recovery.config.mjs';
export default defineConfig({
  ...base,
  testMatch: /event-display-timezones\.spec\.mjs/,
  outputDir: '/tmp/event-display-timezones-results',
  timeout: 120000,
});
