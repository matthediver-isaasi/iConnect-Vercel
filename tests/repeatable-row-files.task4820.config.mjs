import { defineConfig } from '@playwright/test';
import base from './repeatable-row-visibility.config.mjs';

export default defineConfig({
  ...base,
  testMatch: 'repeatable-row-files.task4820.spec.mjs',
  outputDir: '/tmp/repeatable-row-files-task4820-results',
});