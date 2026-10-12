import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = createRequire(import.meta.url)("@tanstack/react-query");
const compiled = await build({ entryPoints: ["client/src/components/sales/QuoteTaskSettings.jsx"], bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic", alias: { "@": `${process.cwd()}/client/src` } });
const mod = new Module(`${process.cwd()}/settings-test.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(compiled.outputFiles[0].text, `${process.cwd()}/settings-test.cjs`);
test("task-list settings persist the trimmed name and expected version, retaining it after save", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  client.setQueryData(["sales-quote-task-settings"], { version: 1, quoteTaskListName: "Quote tasks" });
  const calls = [];
  const request = async (url, options) => {
    if (!options) return { version: 1, quoteTaskListName: "Quote tasks" };
    calls.push(JSON.parse(options.body));
    return { version: 2, quoteTaskListName: "Delivery" };
  };
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(mod.exports.default, { canManage: true, request }))));
    const input = host.querySelector("input");
    assert.equal(input.value, "Quote tasks");
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, " Delivery ");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => { host.querySelector("button").click(); await new Promise(resolve => setTimeout(resolve, 30)); });
    assert.deepEqual(calls, [{ expectedVersion: 1, quoteTaskListName: "Delivery" }]);
    assert.equal(host.querySelector("input").value, "Delivery");
    assert.equal(host.querySelector("button").disabled, true);
  } finally {
    await act(async () => root.unmount()); client.clear(); dom.window.close();
  }
});
