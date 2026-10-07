import {defineConfig} from '@playwright/test';
import base from './monthly-membership-recovery.config.mjs';
export default defineConfig({...base,testMatch:/form-alert-view\.spec\.mjs/,
  outputDir:'/tmp/form-alert-view-results'});
