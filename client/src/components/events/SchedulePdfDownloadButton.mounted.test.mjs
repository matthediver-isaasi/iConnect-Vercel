import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync } from "node:fs";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://tenant.example.test/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
after(() => dom.window.close());

const bundle = await build({
  entryPoints: ["client/src/components/events/SchedulePdfDownloadButton.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  plugins: [{
    name: "isolated-pdf-button",
    setup(builder) {
      builder.onResolve({ filter: /^(?:@\/contexts\/TenantBrandingContext|@\/api\/publicClient|\.\/schedulePdf\.mjs)$/ },
        args => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({
        contents: args.path.includes("TenantBranding")
          ? "export const useTenantBranding = () => globalThis.pdfButtonFixture.tenant;"
          : args.path.includes("publicClient")
            ? "export const publicClient = {getTenantBranding: (...args) => globalThis.pdfButtonFixture.getBranding(...args)};"
            : "export const downloadSchedulePdf = (...args) => globalThis.pdfButtonFixture.download(...args);",
      }));
      builder.onResolve({ filter: /^@\// }, args => {
        const base = `${process.cwd()}/client/src/${args.path.slice(2)}`;
        return { path: [base, `${base}.jsx`, `${base}.js`, `${base}.tsx`, `${base}.ts`].find(existsSync) };
      });
    },
  }],
});
const compiled = new Module(`${process.cwd()}/schedule-pdf-fixture.cjs`);
compiled.filename = `${process.cwd()}/schedule-pdf-fixture.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const Button = compiled.exports.default;
const props = { event: { title: "Visible forum" }, sessions: [{ title: "Allowed session" }], eventTracks: [], trackColorMap: {}, timezone: "Europe/London", speakerMap: {} };
const click = () => act(async () => document.querySelector("button").click());

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Button, props)));
  return async () => { await act(async () => root.unmount()); host.remove(); };
}

test("no eager retrieval; uses the exact visible inputs, busy state prevents duplicate downloads", async () => {
  let brandingCalls = 0;
  let downloads = 0;
  let finish;
  globalThis.pdfButtonFixture = {
    tenant: { branding: { logoUrl: "/current-tenant.svg" } },
    getBranding: () => { brandingCalls++; throw new Error("Should use existing branding"); },
    download: (inputs, logo) => {
      downloads++;
      assert.equal(inputs.sessions, props.sessions);
      assert.equal(inputs.trackColorMap, props.trackColorMap);
      assert.equal(inputs.eventTracks, props.eventTracks);
      assert.equal(inputs.speakerMap, props.speakerMap);
      assert.equal(logo, "/current-tenant.svg");
      return new Promise(resolve => { finish = resolve; });
    },
  };
  const cleanup = await mount();
  try {
    assert.equal(downloads, 0);
    assert.equal(brandingCalls, 0);
    await click();
    assert.equal(document.querySelector("button").disabled, true);
    assert.match(document.querySelector('[role="status"]').textContent, /Preparing/);
    await click();
    assert.equal(downloads, 1);
    await act(async () => finish());
    assert.equal(document.querySelector("button").disabled, false);
    assert.match(document.querySelector("button").textContent, /Download PDF/);
  } finally { await cleanup(); }
});

test("branding resolves from public client only on click, logo failure is visible and retry succeeds", async () => {
  let calls = 0;
  let attempts = 0;
  globalThis.pdfButtonFixture = {
    tenant: null,
    getBranding: async (...args) => { calls++; assert.equal(args.length, 0); return { success: true, branding: { logoUrl: "/tenant.svg" } }; },
    download: async () => { attempts++; if (attempts === 1) throw new Error("The tenant logo could not be included."); },
  };
  const cleanup = await mount();
  try {
    assert.equal(calls, 0);
    await click();
    assert.equal(calls, 1);
    assert.match(document.querySelector('[role="alert"]').textContent, /logo could not be included/);
    assert.equal(document.querySelector("button").disabled, false);
    assert.match(document.querySelector("button").textContent, /Retry/);
    await click();
    assert.equal(calls, 2);
    assert.equal(attempts, 2);
    assert.equal(document.querySelector('[role="alert"]'), null);
  } finally { await cleanup(); }
});

test("missing branding is not silently treated as a successfully included logo", async () => {
  globalThis.pdfButtonFixture = {
    tenant: null,
    getBranding: async () => ({ success: false }),
    download: () => assert.fail("Must not download after branding lookup failure"),
  };
  const cleanup = await mount();
  try {
    await click();
    assert.match(document.querySelector('[role="alert"]').textContent, /branding could not be loaded/);
  } finally { await cleanup(); }
});
