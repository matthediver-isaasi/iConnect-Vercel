import test, { after } from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<html><body></body></html>", { url: "https://isolated.example.test/sales/quotes/q" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = createRequire(import.meta.url)("@tanstack/react-query");
const compiled = await build({
  entryPoints: ["client/src/components/sales/QuoteExhibitionSpaces.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  alias: { "@": `${process.cwd()}/client/src` },
  plugins: [{ name: "exhibition-boundaries", setup(builder) {
    builder.onResolve({ filter: /useSalesSettings$/ }, () => ({ path: "scope", namespace: "fixture" }));
    builder.onResolve({ filter: /^@\/api\/base44Client$/ }, () => ({ path: "api", namespace: "fixture" }));
    builder.onResolve({ filter: /^@\/components\/ui\/button$/ }, () => ({ path: "button", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
      contents: path === "scope" ? 'export const useSalesSettingsScope=()=>({scopeKey:"tenant-test",ready:true});'
        : path === "api" ? 'export const base44={_apiRequest:(...args)=>globalThis.exhibitionFixture.request(...args)};'
          : 'import React from "react"; export const Button=({children,variant,size,...props})=><button {...props}>{children}</button>;',
      loader: "jsx", resolveDir: process.cwd(),
    }));
  } }],
});
const mod = new Module(`${process.cwd()}/exhibition-mounted-fixture.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(compiled.outputFiles[0].text, `${process.cwd()}/exhibition-mounted-fixture.cjs`);
const Spaces = mod.exports.default;
const slot = { key: "slot-key", logicalLineId: "logical-not-database", lineUnit: 1, componentUnit: 2 };
const savedSelection = { slotKey: "slot-key", spaceId: "space-old", reference: "EX-17", priceMinor: 17350, currency: "GBP" };
const line = { key: "db-line", persistedLineId: "db-line", type: "bundle", catalogue_snapshot: { exhibition: { slots: [slot], selections: [savedSelection] } } };
const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
const click = async node => act(async () => node.click());
const button = (host, text) => [...host.querySelectorAll("button")].find(node => node.textContent === text);

async function mount(props = {}, request = async () => ({ items: [] })) {
  globalThis.exhibitionFixture = { request };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
  let currentProps = { line, quoteId: "quote-id", eventId: "event-id", disabled: false, readOnly: false, onSelect: async () => {}, ...props };
  const render = async updates => {
    currentProps = { ...currentProps, ...updates };
    await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Spaces, currentProps))));
  };
  await render({});
  return { host, render, close: async () => { await act(async () => root.unmount()); client.clear(); host.remove(); } };
}
after(() => { delete globalThis.exhibitionFixture; dom.window.close(); });

test("availability is lazy and uses saved database line ID, quote ID and slot key only", async () => {
  const calls = [];
  const fixture = await mount({}, async (path, options) => { calls.push({ path, options }); return { items: [{ id: "space-new", reference: "EX-21", price_minor: 21175, currency: "GBP", status: "available" }] }; });
  try {
    assert.equal(calls.length, 0);
    await click(button(fixture.host, "Replace space")); await settle();
    const url = new URL(calls[0].path, "https://isolated.example.test");
    assert.equal(url.pathname, "/api/sales/exhibition");
    assert.deepEqual(Object.fromEntries(url.searchParams), { resource: "spaces", quoteId: "quote-id", lineId: "db-line", slotKey: "slot-key" });
    assert.equal(calls[0].options.credentials, "include");
    assert.match(fixture.host.textContent, /EX-21 · £211\.75/);
    assert.match(fixture.host.textContent, /EX-17/);
  } finally { await fixture.close(); }
});

test("failed replacement retains prior reference and individual price, and exposes retryable error", async () => {
  const selections = [];
  const fixture = await mount({ onSelect: async (...args) => { selections.push(args); throw new Error("This space was just selected elsewhere"); } }, async () => ({ items: [{ id: "space-new", reference: "EX-21", price_minor: 21175, currency: "GBP", status: "available" }] }));
  try {
    await click(button(fixture.host, "Replace space")); await settle();
    const select = fixture.host.querySelector("select");
    await act(async () => { select.value = "space-new"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.deepEqual(selections, [["slot-key", "space-new"]]);
    assert.match(fixture.host.textContent, /EX-17/);
    assert.match(fixture.host.textContent, /£173\.50/);
    assert.match(fixture.host.querySelector('[role="alert"]').textContent, /selected elsewhere/);
  } finally { await fixture.close(); }
});

test("release submits null, and only a successful authoritative parent reload replaces the reference", async () => {
  let finish;
  const commands = [];
  const fixture = await mount({ onSelect: (...args) => { commands.push(args); return new Promise(resolve => { finish = resolve; }); } });
  try {
    await click(button(fixture.host, "Release"));
    assert.deepEqual(commands, [["slot-key", null]]);
    assert.match(fixture.host.textContent, /EX-17/);
    await fixture.render({ disabled: true });
    assert.equal(button(fixture.host, "Release").disabled, true);
    await act(async () => finish());
    await fixture.render({ disabled: false, line: { ...line, catalogue_snapshot: { exhibition: { slots: [slot], selections: [] } } } });
    assert.doesNotMatch(fixture.host.textContent, /EX-17/);
    assert.match(fixture.host.textContent, /No space selected/);
  } finally { await fixture.close(); }
});

test("dirty, missing-event and unsaved contexts cannot fetch or select inventory; readonly shows saved prices", async () => {
  let calls = 0;
  const fixture = await mount({ disabled: true }, async () => { calls++; return { items: [] }; });
  try {
    assert.equal(button(fixture.host, "Replace space").disabled, true);
    assert.match(fixture.host.textContent, /Save your edits/);
    await fixture.render({ eventId: "" });
    assert.match(fixture.host.textContent, /Choose an Event in the proposal details/);
    assert.equal(fixture.host.querySelectorAll("select").length, 0);
    await fixture.render({ eventId: "event-id", quoteId: "", line: { type: "product" }, disabled: false });
    assert.match(fixture.host.textContent, /Save draft first/);
    assert.match(fixture.host.textContent, /separate, individually priced lines/);
    await fixture.render({ quoteId: "quote-id", line, readOnly: true });
    assert.match(fixture.host.textContent, /EX-17/);
    assert.match(fixture.host.textContent, /£173\.50/);
    assert.equal(fixture.host.querySelectorAll("button").length, 0);
    assert.equal(calls, 0);
  } finally { await fixture.close(); }
});

test("availability failure shows retry; held spaces belonging to another selection cannot be chosen", async () => {
  let calls = 0;
  const fixture = await mount({}, async () => {
    calls++;
    if (calls === 1) throw new Error("Availability unavailable");
    return { items: [{ id: "other-held", reference: "EX-29", price_minor: 18925, currency: "GBP", status: "held" }] };
  });
  try {
    await click(button(fixture.host, "Replace space")); await settle();
    assert.match(fixture.host.querySelector('[role="alert"]').textContent, /Availability unavailable/);
    await click(button(fixture.host, "Retry spaces")); await settle();
    assert.equal(fixture.host.querySelector('option[value="other-held"]').disabled, true);
  } finally { await fixture.close(); }
});

test("truncated availability produces an explicit error and never presents a partial picker as complete", async () => {
  let calls = 0;
  const fixture = await mount({}, async () => {
    calls++;
    return { total: 1001, items: [{ id: "space-new", reference: "EX-21", price_minor: 21175, currency: "GBP", status: "available" }] };
  });
  try {
    await click(button(fixture.host, "Replace space")); await settle();
    assert.match(fixture.host.querySelector('[role="alert"]').textContent, /incomplete: 1 of 1001/);
    assert.match(fixture.host.textContent, /Choosing a space is disabled/);
    assert.equal(fixture.host.querySelectorAll("select").length, 0);
    assert.match(fixture.host.textContent, /EX-17/);
    await click(button(fixture.host, "Retry spaces")); await settle();
    assert.equal(calls, 2);
    assert.equal(fixture.host.querySelectorAll("select").length, 0);
  } finally { await fixture.close(); }
});
