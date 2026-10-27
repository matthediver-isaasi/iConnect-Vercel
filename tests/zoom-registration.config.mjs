import { defineConfig } from '@playwright/test';
import base from './event-registration-consent.config.mjs';
export default defineConfig({ ...base, testMatch: /zoom-registration\.spec\.mjs/, outputDir: '/tmp/zoom-registration-results' });
