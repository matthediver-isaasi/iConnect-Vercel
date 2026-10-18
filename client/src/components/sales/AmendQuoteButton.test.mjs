import test, { after } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const dom = new JSDOM("<html><body></body></html>");
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "MutationObserver"]) {
  globalThis[key] = key === "window" ? dom.window : dom.window[key];
}
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const bundle = await build({
  entryPoints: ["client/src/components/sales/AmendQuoteButton.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  alias: { "@": `${process.cwd()}/client/src` },
});
const mod = new Module(`${process.cwd()}/amend-button-fixture.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(bundle.outputFiles[0].text, `${process.cwd()}/amend-button-fixture.cjs`);
const Amend = mod.exports.default;
after(() => dom.window.close());

test("Amend gives immediate feedback, prevents double-clicks and stays busy through reload", async () => {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  let calls = 0, completePost, completeReload;
  const post = new Promise(resolve => { completePost = resolve; });
  const reload = new Promise(resolve => { completeReload = resolve; });
  try {
    await act(async () => root.render(React.createElement(Amend, {
      pending: false, onAmend: async () => { calls++; await post; await reload; },
    })));
    const button = node.querySelector("button");
    await act(async () => { button.click(); button.click(); });
    assert.equal(calls, 1);
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute("aria-busy"), "true");
    assert.match(button.textContent, /Preparing amendment/);
    assert.ok(button.querySelector(".animate-spin"));
    assert.ok(button.querySelector('[role="status"]'));
    await act(async () => completePost());
    assert.equal(button.disabled, true, "POST completion alone must not re-enable Amend");
    await act(async () => completeReload());
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, "Amend");
  } finally { await act(async () => root.unmount()); node.remove(); }
});

test("failure releases the button for retry; another pending action blocks it", async () => {
  const node = document.createElement("div");
  const root = createRoot(node);
  let calls = 0;
  const onAmend = async () => { calls++; throw new Error("Request failed"); };
  try {
    await act(async () => root.render(React.createElement(Amend, { pending: true, onAmend })));
    node.querySelector("button").click();
    assert.equal(calls, 0);
    await act(async () => root.render(React.createElement(Amend, { pending: false, onAmend })));
    await act(async () => node.querySelector("button").click());
    assert.equal(calls, 1);
    assert.equal(node.querySelector("button").disabled, false);
    await act(async () => node.querySelector("button").click());
    assert.equal(calls, 2);
  } finally { await act(async () => root.unmount()); }
});

test("amendment mutation waits for authoritative detail before hydrating and reporting ready", () => {
  const source = readFileSync("client/src/components/sales/QuotesWorkspace.jsx", "utf8");
  const branch = source.slice(source.indexOf('if (variables.action === "amend")'), source.indexOf('const deliveryAction'));
  assert.match(branch, /await detail\.refetch\(\)/);
  assert.ok(branch.indexOf("setForm(fresh)") > branch.indexOf("await detail.refetch()"));
  assert.match(branch, /Amendment created; reload needed/);
  assert.match(source, /onAmend=\{\(\) => action\.mutateAsync/);
});
