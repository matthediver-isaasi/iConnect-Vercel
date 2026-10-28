import base from "../../../../tests/task-4810-cpd-certificate.config.mjs";

// Like training-reminders.config.mjs: no server/workflow and no live origin.
export default {
  ...base,
  testDir: ".",
  testMatch: /event-follow-ups\.browser\.spec\.mjs/,
  outputDir: "/tmp/event-follow-ups-browser",
  use: { ...base.use, baseURL: "http://event-follow-ups.test" },
};
