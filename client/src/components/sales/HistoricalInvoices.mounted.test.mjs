import test, { after } from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<html><body></body></html>", { url: "https://sales.fixture.invalid" });
for (const key of ["window", "document", "HTMLElement", "Element", "Node"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = createRequire(import.meta.url)("@tanstack/react-query");
after(() => dom.window.close());
const bundle = await build({
  stdin: { contents: `
    export {default as History} from "./HistoricalInvoices.jsx";
    export {default as Schedules} from "./InvoiceSchedulesPanel.jsx";`,
  resolveDir: `${process.cwd()}/client/src/components/sales`, loader: "jsx" },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  alias: { "@": `${process.cwd()}/client/src`, "@shared": `${process.cwd()}/shared` },
  plugins: [{ name: "historical-fixture", setup(builder) {
    builder.onResolve({ filter: /useSalesSettings$/ }, () => ({ path: "scope", namespace: "fixture" }));
    builder.onResolve({ filter: /base44Client$/ }, () => ({ path: "tenant", namespace: "fixture" }));
    builder.onResolve({ filter: /viewerProtectedWorkGate$/ }, () => ({ path: "gate", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
      contents: path === "tenant" ? "export const getActiveTenantId=()=>globalThis.historicalFixture.tenant;"
        : path === "gate" ? "export const getViewerProtectedWorkGeneration=()=>globalThis.historicalFixture.generation; export const isViewerProtectedWorkPaused=()=>globalThis.historicalFixture.paused;"
          : `export const salesSettingsRequest=(...args)=>globalThis.historicalFixture.request(...args);
          export const useSalesSettingsScope=()=>({scopeKey:globalThis.historicalFixture.scope,ready:true,tenant:"tenant-a",generation:0});`,
      loader: "js", resolveDir: process.cwd(),
    }));
  } }],
});
const mod = new Module(`${process.cwd()}/historical-mounted.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(bundle.outputFiles[0].text, `${process.cwd()}/historical-mounted.cjs`);
const { History, Schedules } = mod.exports;
const settle = () => new Promise(resolve => setTimeout(resolve, 25));
const base = { quoteId: "proposal-a", canManageAccounting: true, hasUnsavedEdits: false, savedRevision: "4" };
const stages = () => ({ versionId: "version-4", stages: [
  { groupId: "deposit-id", name: "Exhibition deposit", invoiceNumber: null, canRecord: true, status: "pending",
    groupSnapshot: { id: "deposit-id", name: "Exhibition deposit", grossMinor: 18437, netMinor: 15364, taxMinor: 3073, currency: "GBP", contents: [{ name: "Exhibition space", quantity: 1 }], timing: { kind: "acceptance", days: 0 } } },
  { groupId: "blocked-id", name: "Final balance", invoiceNumber: null, canRecord: false, status: "processing",
    groupSnapshot: { id: "blocked-id", name: "Final balance", grossMinor: 92761, currency: "EUR" } },
] });
async function mount(props = {}, request = async () => stages(), Component = History) {
  globalThis.historicalFixture = { scope: "tenant-a-viewer", tenant: "tenant-a", generation: 0, paused: false, request };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity, retry: false } } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const render = async value => {
    await act(async () => { root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Component, value))); await settle(); });
    await act(settle);
  };
  await render({ ...base, ...props });
  return { host, client, render, async close() { await act(async () => root.unmount()); client.clear(); host.remove(); } };
}
const button = (host, text) => [...host.querySelectorAll("button")].find(node => node.textContent.includes(text));
const click = async node => { assert.ok(node); await act(async () => { node.click(); await settle(); }); await act(settle); };
async function fill(host, number = "OLD-2023-187") {
  await act(async () => {
    const input = host.querySelector('input:not([type="checkbox"])');
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, number);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await click(host.querySelector('input[type="checkbox"]'));
}

test("records once with explicit confirmation, scoped headers and authoritative version; refetches completion", async () => {
  let server = stages();
  const calls = [];
  const fixture = await mount({}, async (path, options = {}) => {
    calls.push({ path, ...options });
    if (options.method === "POST") {
      server = { ...server, stages: server.stages.map(row => row.canRecord ? { ...row, canRecord: false, invoiceNumber: "OLD-2023-187" } : row) };
      return { recorded: true };
    }
    return server;
  });
  try {
    assert.equal(fixture.host.querySelectorAll('input:not([type="checkbox"])').length, 1);
    const input = fixture.host.querySelector("input");
    assert.equal(input.maxLength, 100);
    assert.match(input.closest("label").textContent, /Exhibition deposit/);
    assert.match(fixture.host.textContent, /£184\.37 GBP/);
    assert.match(fixture.host.textContent, /€927\.61 EUR/);
    assert.match(fixture.host.querySelector('input[type="checkbox"]').closest("label").textContent, /Exhibition deposit \(£184\.37 GBP\)/);
    assert.equal(button(fixture.host, "Record existing").disabled, true);
    assert.match(fixture.host.textContent, /cannot be undone/);
    assert.doesNotMatch(fixture.host.textContent, /deposit-id|blocked-id|version-4/);
    await fill(fixture.host, " OLD-2023-187 ");
    assert.equal(button(fixture.host, "Record existing").disabled, false);
    await click(button(fixture.host, "Record existing"));
    const posts = calls.filter(call => call.method === "POST");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].path, "/api/sales/quotes/proposal-a?action=historical-invoices");
    assert.deepEqual(JSON.parse(posts[0].body), { versionId: "version-4", groupId: "deposit-id", invoiceNumber: "OLD-2023-187", expectedGroup: stages().stages[0].groupSnapshot });
    assert.deepEqual(posts[0].headers, { "X-Tenant-Id": "tenant-a" });
    assert.ok(calls.filter(call => call.method !== "POST").length >= 2);
    assert.ok(calls.every(call => call.path === "/api/sales/quotes/proposal-a?action=historical-invoices"));
    assert.match(fixture.host.textContent, /Invoicing complete — existing invoice/);
    assert.match(fixture.host.textContent, /OLD-2023-187/);
    assert.match(fixture.host.textContent, /Payment not verified/);
    assert.equal(button(fixture.host, "Record existing"), undefined);
  } finally { await fixture.close(); }
});

test("repriced snapshots require fresh confirmation and are posted without dropping persisted fields", async () => {
  let server = stages();
  const writes = [];
  const fixture = await mount({}, async (_path, options = {}) => {
    if (options.method === "POST") { writes.push(JSON.parse(options.body)); return { recorded: true }; }
    return server;
  });
  try {
    await fill(fixture.host);
    assert.equal(button(fixture.host, "Record existing").disabled, false);
    server = { ...server, stages: server.stages.map(stage => stage.canRecord ? {
      ...stage, groupSnapshot: { ...stage.groupSnapshot, grossMinor: 21379, persistedMetadata: { revision: "reprice-2", discounts: [137] } },
    } : stage) };
    await act(async () => { await fixture.client.invalidateQueries({ queryKey: ["sales-historical-invoices"] }); await settle(); });
    await act(settle);
    assert.match(fixture.host.textContent, /£213\.79 GBP/);
    assert.equal(fixture.host.querySelector('input[type="checkbox"]').checked, false);
    assert.equal(button(fixture.host, "Record existing").disabled, true);
    await click(fixture.host.querySelector('input[type="checkbox"]'));
    await click(button(fixture.host, "Record existing"));
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].expectedGroup, server.stages[0].groupSnapshot);
  } finally { await fixture.close(); }
});

test("unsaved changes, missing accounting permission and busy proposal disable recording", async () => {
  let writes = 0;
  const fixture = await mount({}, async (_path, options = {}) => { if (options.method === "POST") writes++; return stages(); });
  try {
    for (const props of [{ hasUnsavedEdits: true }, { canManageAccounting: false }, { disabled: true }]) {
      await fixture.render({ ...base, ...props });
      assert.equal(fixture.host.querySelector("input").disabled, true);
      assert.equal(fixture.host.querySelector('input[type="checkbox"]').disabled, true);
      assert.equal(button(fixture.host, "Record existing").disabled, true);
      await click(button(fixture.host, "Record existing"));
    }
    assert.equal(writes, 0);
    await fixture.render({ ...base, hasUnsavedEdits: true });
    assert.match(fixture.host.textContent, /Save your proposal changes first/);
    await fixture.render({ ...base, quoteId: null });
    assert.equal(fixture.host.textContent, "");
  } finally { await fixture.close(); }
});

test("viewer generation and tenant fences reject stale commands before any POST", async () => {
  for (const change of [{ generation: 1 }, { tenant: "tenant-b" }, { paused: true }]) {
    let writes = 0;
    const fixture = await mount({}, async (_path, options = {}) => { if (options.method === "POST") writes++; return stages(); });
    try {
      await fill(fixture.host);
      Object.assign(globalThis.historicalFixture, change);
      await click(button(fixture.host, "Record existing"));
      assert.equal(writes, 0);
      assert.match(fixture.host.querySelector('[role="alert"]').textContent, /reload billing stages/i);
    } finally { await fixture.close(); }
  }
});

test("failed discovery blocks recording and offers retry; POST errors do not claim completion", async () => {
  let failGet = true;
  const fixture = await mount({}, async (_path, options = {}) => {
    if (options.method === "POST") throw new Error("Stage is already being invoiced");
    if (failGet) throw new Error("Billing history unavailable");
    return stages();
  });
  try {
    assert.match(fixture.host.textContent, /Billing history unavailable/);
    assert.equal(fixture.host.querySelector("input"), null);
    failGet = false;
    await click(button(fixture.host, "Retry loading"));
    await fill(fixture.host);
    await click(button(fixture.host, "Record existing"));
    assert.match(fixture.host.querySelector('[role="alert"]').textContent, /Stage is already being invoiced/);
    assert.doesNotMatch(fixture.host.textContent, /Existing invoice recorded for/);
    assert.ok(button(fixture.host, "Record existing"));
  } finally { await fixture.close(); }
});

test("accepted historical group renders complete, unverified payment and no retry or refresh", async () => {
  const fixture = await mount({ saleId: "sale-a", access: { canViewInvoice: true, canRetryInvoice: true } }, async () => ({
    schedules: [{ id: "internal-schedule", status: "no_invoice_required", manual_invoice_number: "LEGACY-839",
      can_retry: false, can_refresh: false, snapshot: { name: "Exhibition deposit", grossMinor: 18437, currency: "GBP" } }],
  }), Schedules);
  try {
    assert.match(fixture.host.textContent, /Invoicing complete — existing invoice/);
    assert.match(fixture.host.textContent, /LEGACY-839/);
    assert.match(fixture.host.textContent, /Payment not verified/);
    assert.match(fixture.host.textContent, /Delivery not required/);
    assert.doesNotMatch(fixture.host.textContent, /internal-schedule|Not yet created/);
    assert.equal(button(fixture.host, "Retry this group"), undefined);
    assert.equal(button(fixture.host, "Refresh payment status"), undefined);
  } finally { await fixture.close(); }
});
