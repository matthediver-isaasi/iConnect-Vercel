import { chromium, defineConfig } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import base from "../playwright.config.mjs";

// PDF.js 5 requires modern browser primitives; use the bundled Chromium if
// installed, and never substitute old system Chromium without explicit opt-in.
const bundled = chromium.executablePath();
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  || (existsSync(bundled) ? bundled : undefined);
const launchOptions = { executablePath };
// Playwright's downloaded browser is not Nix-patched. Supply the already
// installed system Chromium's runtime closure libraries to the browser
// process only (not Node or bash), excluding its incompatible glibc.
let libraryPath = process.env.PLAYWRIGHT_NIX_CHROME_LIB_PATH;
if (!libraryPath && executablePath === bundled && existsSync("/nix/store")) {
  const wrapper = execFileSync("which", ["chromium"], { encoding: "utf8" }).trim();
  const unwrapped = readFileSync(wrapper, "utf8")
    .match(/exec "([^"]+-chromium-unwrapped-[^"]+)\/libexec\/chromium\/chromium"/)?.[1];
  if (unwrapped) {
    libraryPath = execFileSync("nix-store", ["-qR", unwrapped], { encoding: "utf8" })
      .trim().split("\n")
      .filter(path => !path.includes("glibc-") && existsSync(`${path}/lib`))
      .map(path => `${path}/lib`).join(":");
  }
}
if (libraryPath) {
  launchOptions.env = { ...process.env, LD_LIBRARY_PATH: libraryPath };
}

export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: /task-4810-cpd-certificate\.spec\.mjs/,
  outputDir: "/tmp/task-4810-cpd-certificate-results",
  workers: 1,
  fullyParallel: false,
  use: {
    ...base.use,
    baseURL: "http://127.0.0.1:5000",
    viewport: { width: 1440, height: 900 },
    launchOptions,
  },
});