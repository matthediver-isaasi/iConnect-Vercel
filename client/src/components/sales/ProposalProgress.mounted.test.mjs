import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<html><body><div id='root'></div></body></html>", { url: "https://fixture.invalid" });
for (const key of ["window", "document", "HTMLElement", "Element", "Node"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");

async function component(entry) {
  const bundled = await build({
    entryPoints: [`client/src/components/sales/${entry}.jsx`], bundle: true, write: false,
    packages: "external", platform: "node", format: "cjs", jsx: "automatic",
    plugins: [{ name: "button-fixture", setup(builder) {
      builder.onResolve({ filter: /^@\/components\/ui\/button$/ }, () => ({ path: "button", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: 'import React from "react"; export const Button=({variant,children,...props})=><button {...props}>{children}</button>;', loader: "jsx", resolveDir: process.cwd(),
      }));
    } }],
  });
  const mod = new Module(`${process.cwd()}/proposal-fixture.cjs`);
  mod.paths = Module._nodeModulePaths(process.cwd());
  mod._compile(bundled.outputFiles[0].text, `${process.cwd()}/proposal-fixture.cjs`);
  return mod.exports.default;
}
const Progress = await component("ProposalProgress");
const Revoke = await component("RevokeQuoteLink");

test("progress remains accessible and accurate as lifecycle changes", async () => {
  const host = document.getElementById("root");
  const root = createRoot(host);
  try {
    for (const status of ["draft", "issued", "sent", "accepted", "converted"]) {
      await act(async () => root.render(React.createElement(Progress, { status, singular: "Training proposal" })));
      assert.equal(host.querySelector("section").getAttribute("aria-label"), "Training proposal progress");
      assert.equal(host.querySelectorAll("ol > li").length, 5);
      assert.equal(host.querySelectorAll('[aria-current="step"]').length, 1);
      assert.match(host.querySelector('[aria-current="step"]').textContent, {
        draft: /Prepare draft/, issued: /Ready to send/, sent: /Awaiting customer/, accepted: /Accepted/, converted: /Converted/,
      }[status]);
      if (["accepted", "converted"].includes(status)) assert.match(host.querySelectorAll("li")[2].textContent, /Not confirmed/);
    }
    for (const status of ["revoked", "expired", "rejected", "declined", "superseded"]) {
      await act(async () => root.render(React.createElement(Progress, { status })));
      assert.equal(host.querySelector('[aria-current="step"]'), null);
      assert.match(host.querySelector('[role="status"]').textContent.toLowerCase(), new RegExp(status));
      assert.ok([...host.querySelectorAll("li")].every(item => item.textContent.includes("Not confirmed")));
    }
  } finally { await act(async () => root.unmount()); }
});

test("revoke is described, blocks unavailable/stale links and reacts to authoritative refreshes", async () => {
  const host = document.getElementById("root");
  const root = createRoot(host);
  let revocations = 0;
  const base = { status: "issued", permitted: true, onRevoke: () => revocations++ };
  try {
    for (const props of [
      { hasActiveDeliveryLink: false },
      { hasActiveDeliveryLink: undefined },
      { hasActiveDeliveryLink: true, loading: true },
      { hasActiveDeliveryLink: true, error: new Error("Metadata failed") },
      { hasActiveDeliveryLink: true, pending: true },
      { hasActiveDeliveryLink: true, permitted: false },
    ]) {
      await act(async () => root.render(React.createElement(Revoke, { ...base, ...props })));
      const button = host.querySelector("button");
      assert.equal(button.disabled, true);
      assert.ok(document.getElementById(button.getAttribute("aria-describedby")).textContent);
      await act(async () => button.click());
    }
    assert.equal(revocations, 0);
    await act(async () => root.render(React.createElement(Revoke, { ...base, status: "sent", hasActiveDeliveryLink: true })));
    assert.equal(host.querySelector("button").disabled, false);
    await act(async () => host.querySelector("button").click());
    assert.equal(revocations, 1);
    await act(async () => root.render(React.createElement(Revoke, { ...base, status: "sent", hasActiveDeliveryLink: false })));
    assert.equal(host.querySelector("button").disabled, true);
    await act(async () => host.querySelector("button").click());
    assert.equal(revocations, 1);
    assert.match(host.textContent, /revoked or expired/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
