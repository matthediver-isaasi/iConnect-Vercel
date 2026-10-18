import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<html><body><div id='root'></div></body></html>", { url: "https://fixture.invalid" });
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "NodeFilter", "HTMLInputElement", "MutationObserver", "CustomEvent", "DocumentFragment"]) globalThis[key] = key === "window" ? dom.window : dom.window[key];
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const bundle = await build({ entryPoints: ["client/src/components/sales/AcceptQuoteButton.jsx"], bundle: true, write: false,
  packages: "external", platform: "node", format: "cjs", jsx: "automatic", alias: { "@": `${process.cwd()}/client/src` },
  plugins: [{
    name: "quote-naming-fixture",
    setup(builder) {
      builder.onResolve({ filter: /hooks\/useSalesSettings$/ }, () => ({ path: "naming", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: 'export const useQuoteNaming = () => ({ singular: "Training Proposal", plural: "Training Proposals", slug: "training-proposals" });',
      }));
    },
  }],
});
const mod = new Module(`${process.cwd()}/accept-quote-fixture.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(bundle.outputFiles[0].text, `${process.cwd()}/accept-quote-fixture.cjs`);
const Component = mod.exports.default;
const root = createRoot(document.getElementById("root"));
test("admin acceptance is permission/status gated and requires explicit confirmation", async () => {
  const calls = [];
  const props = { status: "issued", permitted: true, pending: false, onAccept: async input => calls.push(input) };
  const button = text => [...document.querySelectorAll("button")].find(node => node.textContent === text);
  try {
    for (const status of ["draft", "accepted", "declined", "expired", "converted", "superseded"]) {
      await act(async () => root.render(React.createElement(Component, { ...props, status })));
      assert.equal(button("Mark as accepted"), undefined);
    }
    await act(async () => root.render(React.createElement(Component, { ...props, permitted: false })));
    assert.equal(button("Mark as accepted"), undefined);
    await act(async () => root.render(React.createElement(Component, props)));
    await act(async () => button("Mark as accepted").click());
    assert.match(document.body.textContent, /Accept Training Proposal on the customer’s behalf/);
    assert.match(document.body.textContent, /agreed to this Training Proposal/);
    assert.equal(calls.length, 0);
    const textarea = document.querySelector("textarea");
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(textarea, "Customer approved by phone");
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => button("Confirm acceptance").click());
    assert.deepEqual(calls, [{ status: "accepted", note: "Customer approved by phone" }]);
    assert.equal(button("Confirm acceptance"), undefined);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
