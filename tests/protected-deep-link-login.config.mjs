import { defineConfig } from '@playwright/test';
import base from './form-submissions-csv.config.mjs';

export default defineConfig({
  ...base,
  testMatch: 'protected-deep-link-login.spec.mjs',
  outputDir: '/tmp/protected-deep-link-login-results',
  use: { ...base.use, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' },
});
