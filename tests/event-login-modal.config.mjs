import { defineConfig } from '@playwright/test';
import base from './portal-session-boundaries.config.mjs';
export default defineConfig({
  ...base,
  testMatch: /event-login-modal\.spec\.mjs/,
  outputDir: '/tmp/event-login-modal-results',
});