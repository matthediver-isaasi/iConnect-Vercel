import { defineConfig } from '@playwright/test';
import base from './task-4810-cpd-certificate.config.mjs';
export default defineConfig({
  ...base, testMatch: /training-speaker-scope\.spec\.mjs/,
  outputDir: '../generated-artifacts/training-speaker-scope',
  use: {...base.use,baseURL:'http://training-speakers.fixture'},
});
