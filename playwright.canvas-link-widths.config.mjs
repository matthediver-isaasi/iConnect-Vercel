import base from './playwright.config.mjs';
export default {
  ...base,
  testMatch: /canvas-(?:link-widths|pane-scroll|symbol-content\.task4903)\.spec\.mjs/,
  outputDir: 'test-results/canvas-link-widths',
  timeout: 90_000,
};
