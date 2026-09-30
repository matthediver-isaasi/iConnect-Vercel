import base from "./playwright.config.mjs";
import { defineConfig } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";

// Replit's Nix Chromium includes its own runtime libraries; the downloaded
// Playwright headless shell cannot start here without system libglib.
const nixChromium = (() => {
  try {
    return readdirSync("/nix/store")
      .filter(name => /-chromium-\d/.test(name))
      .sort((a, b) => Number(b.match(/-chromium-(\d+)/)?.[1] || 0) - Number(a.match(/-chromium-(\d+)/)?.[1] || 0))
      .map(name => `/nix/store/${name}/bin/chromium`)
      .find(existsSync);
  } catch {
    return undefined;
  }
})();

export default defineConfig({
  ...base,
  testDir: "./tests",
  testMatch: /task-4782-duplicate-fields\.spec\.mjs/,
  outputDir: "test-results/task-4782-duplicate-fields",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  use: {
    ...base.use,
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5000",
    launchOptions: {
      ...base.use.launchOptions,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || nixChromium
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || nixChromium }
        : {}),
    },
  },
});