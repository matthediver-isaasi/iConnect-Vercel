import { defineConfig } from '@playwright/test';
import base from './task-4810-cpd-certificate.config.mjs';

export default defineConfig({
  ...base,
  testMatch: /certificate-survey-route\.spec\.mjs/,
  outputDir: '/tmp/certificate-survey-route-results',
});