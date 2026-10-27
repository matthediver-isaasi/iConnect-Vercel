import base from './task-4810-cpd-certificate.config.mjs';
export default { ...base, testMatch: /training-reminders\.spec\.mjs/, outputDir: '/tmp/training-reminders-browser', use: { ...base.use, baseURL: 'http://training-reminders.test' } };
