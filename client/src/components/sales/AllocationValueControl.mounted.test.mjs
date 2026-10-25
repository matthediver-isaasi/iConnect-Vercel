import test, { after } from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<html><body></body></html>", { url: "https://isolated.example.test/sales" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = createRequire(import.meta.url)("@tanstack/react-query");
const compiled = await build({
  entryPoints: ["client/src/components/sales/AllocationValueControl.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  alias: { "@": `${process.cwd()}/client/src` },
  plugins: [{ name: "allocation-boundaries", setup(builder) {
    builder.onResolve({ filter: /useSalesSettings$/ }, () => ({ path: "scope", namespace: "fixture" }));
    builder.onResolve({ filter: /^@\/components\/ui\// }, args => ({ path: args.path, namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
      contents: path === "scope" ? `
        export const useSalesSettingsScope=()=>({scopeKey:"tenant-test",ready:true,tenant:"tenant-test"});
        export const salesSettingsRequest=(...args)=>globalThis.allocationFixture.request(...args);
      ` : `
        import React from "react";
        export const Badge=({children})=><span>{children}</span>;
        export const Button=({children,variant,size,...props})=><button {...props}>{children}</button>;
        export const Input=props=><input {...props}/>;
        export const Textarea=props=><textarea {...props}/>;
        export const Label=props=><label {...props}/>;
        export const Dialog=({open,children})=>open?<section role="dialog">{children}</section>:null;
        export const DialogContent=({children})=><div>{children}</div>;
        export const DialogHeader=DialogContent;
        export const DialogTitle=DialogContent;
        export const DialogDescription=DialogContent;
        export const DialogFooter=DialogContent;
      `, loader: "jsx", resolveDir: process.cwd(),
    }));
  } }],
});
const mod = new Module(`${process.cwd()}/allocation-mounted-test.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(compiled.outputFiles[0].text, `${process.cwd()}/allocation-mounted-test.cjs`);
const Control = mod.exports.default;
const pending = { status: "pending", currency: "GBP", netMinor: null, taxMinor: null, lineNetMinor: 42743, lineTaxMinor: 8549, places: 3 };
const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
async function mount(request) {
  globalThis.allocationFixture = { request };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Control, { allocationId: "allocation-test" }))));
  await settle(); await settle();
  return { host, close: async () => { await act(async () => root.unmount()); client.clear(); host.remove(); } };
}
const click = async element => act(async () => element.click());
const button = (host, text) => [...host.querySelectorAll("button")].find(el => el.textContent === text);
async function fill(element, value) {
  await act(async () => {
    const proto = element.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
    element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    element.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}
after(() => { delete globalThis.allocationFixture; dom.window.close(); });

test("member allocation managers never request the protected value endpoint", async () => {
  const calls = [];
  const fixture = await mount(async path => { calls.push(path); return { authenticated: false }; });
  try {
    assert.deepEqual(calls, ["/api/auth/tenant-user-me"]);
    assert.equal(fixture.host.textContent, "");
  } finally { await fixture.close(); }
});

test("admin assigns total net with reason, retains exact retry payload and shows returned totals", async () => {
  const posts = [];
  const fixture = await mount(async (path, options = {}) => {
    if (path.includes("tenant-user-me")) return { authenticated: true, tenant: { id: "tenant-test" } };
    if (options.method !== "POST") return pending;
    posts.push(JSON.parse(options.body));
    if (posts.length === 1) throw new Error("Connection lost");
    return { ...pending, status: "allocated", netMinor: 12743, taxMinor: 2549 };
  });
  const { host } = fixture;
  try {
    assert.match(host.textContent, /Pending allocation/);
    await click(button(host, "Assign ticket value"));
    assert.match(host.textContent, /no new invoice or payment/);
    assert.match(host.textContent, /not a per-ticket price/);
    await fill(host.querySelector("input"), "-1");
    await fill(host.querySelector("textarea"), "Ticket share");
    assert.equal(button(host, "Assign total net value").disabled, true);
    await fill(host.querySelector("input"), "127.431");
    assert.equal(button(host, "Assign total net value").disabled, true);
    await fill(host.querySelector("input"), "127.43");
    await fill(host.querySelector("textarea"), "  ");
    assert.equal(button(host, "Assign total net value").disabled, true);
    await fill(host.querySelector("textarea"), " Ticket share ");
    await act(async () => host.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    assert.match(host.textContent, /Connection lost/);
    await click(button(host, "Close"));
    await click(button(host, "Assign ticket value"));
    await act(async () => host.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[1], posts[0]);
    assert.equal(posts[0].netMinor, 12743);
    assert.equal(posts[0].reason, "Ticket share");
    assert.match(posts[0].idempotencyKey, /^[0-9a-f-]{36}$/);
    assert.match(host.textContent, /Assigned ticket value.*127.43.*25.49/);
    assert.equal(host.querySelector('[role="dialog"]'), null);
  } finally { await fixture.close(); }
});

test("resolved zero is assigned, historical null is unavailable, neither can be assigned", async () => {
  for (const data of [{ ...pending, status: "allocated", netMinor: 0, taxMinor: 0 }, { ...pending, status: "historical" }]) {
    const fixture = await mount(async path => path.includes("tenant-user-me") ? { authenticated: true, tenant: { id: "tenant-test" } } : data);
    try {
      assert.equal(button(fixture.host, "Assign ticket value"), undefined);
      assert.match(fixture.host.textContent, data.status === "allocated" ? /0.00/ : /Historical ticket value.*Unavailable/);
    } finally { await fixture.close(); }
  }
});
