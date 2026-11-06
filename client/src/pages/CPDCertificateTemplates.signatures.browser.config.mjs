import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import base from '../../../playwright.config.mjs';

export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: /CPDCertificateTemplates\.signatures\.browser\.spec\.mjs/,
  outputDir: '/tmp/cpd-certificate-signature-results',
  workers: 1,
  use: {
    ...base.use,
    baseURL: process.env.PLAYWRIGHT_BASE_URL || base.use?.baseURL || 'http://127.0.0.1:5000',
    viewport: { width: 1440, height: 1000 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
      execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim() },
  },
  webServer: undefined,
  // Uses an already-running Vite preview. Never starts a workflow/server.
});
