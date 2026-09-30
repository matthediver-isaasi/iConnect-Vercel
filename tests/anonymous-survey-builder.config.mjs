import { defineConfig } from '@playwright/test';
import base from './task-4810-cpd-certificate.config.mjs';

export default defineConfig({
  ...base,
  testMatch: /anonymous-survey-builder\.spec\.mjs/,
  outputDir: '/tmp/anonymous-survey-builder-results',
});