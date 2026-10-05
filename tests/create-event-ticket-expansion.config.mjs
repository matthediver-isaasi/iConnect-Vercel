import { defineConfig } from '@playwright/test';
import releaseConfig from './ticket-release.task4906.config.mjs';

export default defineConfig({
  ...releaseConfig,
  testMatch: 'create-event-ticket-expansion.spec.mjs',
  outputDir: '/tmp/create-event-ticket-expansion-results',
});
