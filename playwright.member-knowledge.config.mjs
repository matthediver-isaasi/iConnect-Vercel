import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./tests',testMatch:/member-knowledge\.spec\.mjs/,workers:1,
  timeout:60000,
  use:{baseURL:'http://127.0.0.1:5000',headless:true,viewport:{width:1280,height:900},
    launchOptions:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {},
    screenshot:'only-on-failure',trace:'retain-on-failure'},
});