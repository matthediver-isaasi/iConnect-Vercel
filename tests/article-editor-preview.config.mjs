import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';

export default defineConfig({
  testDir: '.', testMatch: /article-editor-preview\.spec\.mjs/,
  outputDir: '/tmp/article-editor-preview-results', workers: 1,
  use: { headless: true, launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
      execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(),
  } },
});
