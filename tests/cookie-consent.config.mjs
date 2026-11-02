import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'.',testMatch:/cookie-consent\.spec\.mjs/,workers:1,timeout:45000,
  outputDir:'/tmp/cookie-consent-browser',
  use:{baseURL:process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : 'http://127.0.0.1:5000',headless:true,
    launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined}},
});
