import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { POPUP_DEFAULT_CONFIG } from "../../../../shared/cmsPopupContract.js";

const dom = new JSDOM("<!doctype html><html><body><button id='origin'>Open</button><div id='root'></div></body></html>", { url: "https://isolated.example.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Element", "Node", "NodeFilter", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "CustomEvent", "KeyboardEvent", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
let measuredWidth = 310;
globalThis.ResizeObserver = class {
  constructor(callback) { this.callback = callback; }
  observe() { this.callback([{ contentRect: { width: measuredWidth } }]); }
  disconnect() {}
};
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const bundle = await build({
  entryPoints: ["client/src/components/popups/PopupModal.jsx"], bundle: true, write: false,
  packages: "external", platform: "node", format: "cjs", jsx: "automatic", logLevel: "silent",
  plugins: [{
    name: "popup-renderer-seam",
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/|$)/ }, (args) => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /^@\/(components\/canvas\/CanvasPageRenderer|lib\/cmsPopups)$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        contents: path.includes("cmsPopups") ? "export const popupConfig = p => p.config;"
          : `import React from 'react'; export default function Renderer(props) { return <div id="rendered" data-breakpoint={props.forceBreakpoint} data-width={props.contentWidth}><button id="interactive">Popup action</button></div>; }`,
        loader: "jsx",
      }));
    },
  }],
});
const module = new Module(`${process.cwd()}/popup-modal-isolated.cjs`);
module.filename = `${process.cwd()}/popup-modal-isolated.cjs`;
module.paths = Module._nodeModulePaths(process.cwd());
module._compile(bundle.outputFiles[0].text, module.filename);
const PopupModal = module.exports.default;
after(() => { dom.window.close(); delete globalThis.ResizeObserver; });
test("a narrow dialog in a wide viewport uses content-width mobile geometry and an accessible close action", async () => {
  measuredWidth = 310;
  document.getElementById("origin").focus();
  const root = createRoot(document.getElementById("root"));
  let closed = false;
  const popup = { id: "isolated-popup", name: "Service announcement", design: {}, config: structuredClone(POPUP_DEFAULT_CONFIG) };
  await act(async () => {
    root.render(React.createElement(PopupModal, { popup, open: true, onClose: () => { closed = true; } }));
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
  const dialog = document.querySelector("[role=dialog]");
  assert.ok(dialog);
  assert.equal(document.getElementById("rendered").dataset.breakpoint, "mobile");
  assert.equal(document.getElementById("rendered").dataset.width, "310");
  assert.match(dialog.style.maxHeight, /dvh/);
  assert.ok(document.querySelector('button[aria-label="Close popup"]'));
  assert.ok(dialog.contains(document.activeElement), "Radix moves focus into the modal");
  await act(async () => document.querySelector('button[aria-label="Close popup"]').click());
  assert.equal(closed, true);
  await act(async () => root.unmount());
});
test("delayed close autofocus never steals focus from a newly opened external dialog", async () => {
  const origin = document.getElementById("origin");
  origin.focus();
  const root = createRoot(document.getElementById("root"));
  const popup = { id: "isolated-popup-focus", name: "Notice", design: {}, config: structuredClone(POPUP_DEFAULT_CONFIG) };
  await act(async () => {
    root.render(React.createElement(PopupModal, { popup, open: true, onClose: () => {} }));
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
  const external = document.createElement("div");
  external.setAttribute("role", "dialog");
  external.innerHTML = '<input aria-label="Inbox search">';
  document.body.append(external);
  await act(async () => {
    root.unmount();
    external.firstElementChild.focus();
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
  assert.equal(document.activeElement, external.firstElementChild);
  external.remove();
});
