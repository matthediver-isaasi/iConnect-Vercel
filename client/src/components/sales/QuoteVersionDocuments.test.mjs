import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import React, { act } from "react";
import { JSDOM } from "jsdom";

const result = await build({
  entryPoints: ["client/src/components/sales/QuoteVersionDocuments.jsx"],
  bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
  jsx: "automatic", alias: { "@": `${process.cwd()}/client/src` },
});
const mod = new Module(`${process.cwd()}/quote-version-fixture.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(result.outputFiles[0].text, `${process.cwd()}/quote-version-fixture.cjs`);

test("version options are unique, numerically ordered and never fabricated from missing numbers", () => {
  assert.deepEqual(mod.exports.uniqueQuoteVersions([
    { version_number: 1 }, { version_number: 1 }, { versionNumber: "1" },
    { version_number: 2 }, { version_number: 10 }, {}, { version_number: 0 },
  ]).map(row => row.number), [10, 2, 1]);
});

test("every version has working PDF actions; dirty current drafts do not block historical PDFs", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const calls = [];
  const props = {
    versions: mod.exports.uniqueQuoteVersions([{ version_number: 1, status: "superseded" }, { version_number: 2, status: "draft" }]),
    currentVersion: 2, onPdf: value => calls.push(value), pending: false, dirty: true,
  };
  const button = label => document.querySelector(`[aria-label="${label}"]`);
  try {
    await act(async () => root.render(React.createElement(mod.exports.default, props)));
    assert.equal(button("Preview PDF version 2").disabled, true);
    assert.equal(button("Download PDF version 2").disabled, true);
    await act(async () => { button("Preview PDF version 1").click(); button("Download PDF version 1").click(); });
    assert.deepEqual(calls, [{ preview: true, version: 1 }, { preview: false, version: 1 }]);
    await act(async () => root.render(React.createElement(mod.exports.default, { ...props, dirty: false })));
    await act(async () => button("Preview PDF version 2").click());
    assert.deepEqual(calls.at(-1), { preview: true, version: 2 });
    await act(async () => root.render(React.createElement(mod.exports.default, { ...props, pending: true })));
    assert.equal(button("Preview PDF version 1").disabled, true);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
