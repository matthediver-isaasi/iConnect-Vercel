import { defineConfig } from '@playwright/test';
import existing from './member-communication-status.config.mjs';
export default defineConfig({
  ...existing,
  testMatch: /subscription-counts\.spec\.mjs/,
  outputDir: '/tmp/subscription-counts-results',
});
