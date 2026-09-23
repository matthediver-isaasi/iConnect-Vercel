import base from "./playwright.config.mjs";
export default {
  ...base,
  testMatch: /canvas-pane-scroll\.spec\.mjs/,
  outputDir: "test-results/canvas-pane-scroll",
  timeout: 90_000,
};