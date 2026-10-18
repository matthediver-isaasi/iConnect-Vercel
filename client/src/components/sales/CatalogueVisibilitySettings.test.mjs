import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = createRequire(import.meta.url)("@tanstack/react-query");
const compiled = await build({
  stdin: { contents: `
    export {default as Visibility} from "./client/src/components/sales/CatalogueVisibilitySettings";
    export {default as Tasks} from "./client/src/components/sales/QuoteTaskSettings";
    export {default as Context} from "./client/src/contexts/LayoutContext";
    export {setActiveTenantId, getActiveTenantId} from "@/api/base44Client";`,
    resolveDir: process.cwd(), loader: "jsx" },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs",
  jsx: "automatic", alias: { "@": `${process.cwd()}/client/src` },
  plugins: [{ name: "tenant-store", setup(build) {
    build.onResolve({ filter: /base44Client$/ }, () => ({ path: "tenant", namespace: "fixture" }));
    build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
      let tenant='tenant-a'; const listeners=new Set();
      export const getActiveTenantId=()=>tenant;
      export const subscribeToActiveTenantId=listener=>{listeners.add(listener);return ()=>listeners.delete(listener)};
      export const setActiveTenantId=value=>{tenant=value;listeners.forEach(listener=>listener())};`,
    }));
  } }],
});
const mod = new Module(`${process.cwd()}/visibility-test.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(compiled.outputFiles[0].text, `${process.cwd()}/visibility-test.cjs`);
const fixture = mod.exports;
const initial = { version: 1, showInternalCode: true, showSku: true, quoteTaskListName: "Quote tasks" };
const settle = () => new Promise(resolve => setTimeout(resolve, 40));
async function mount(request, { canManage = true, both = true } = {}) {
  fixture.setActiveTenantId("tenant-a");
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity },
  } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(QueryClientProvider, { client },
      React.createElement(fixture.Context.Provider, { value: { authResolved: true, sessionValidated: true } },
        React.createElement(React.Fragment, null,
          React.createElement(fixture.Visibility, { canManage, request }),
          both && React.createElement(fixture.Tasks, { canManage, request })))));
    await settle();
  });
  await act(settle);
  return { host, client, async close() {
    await act(async () => root.unmount()); client.clear(); host.remove();
  } };
}
const button = (host, label) => [...host.querySelectorAll("button")].find(node => node.textContent === label);
async function click(node) { await act(async () => { node.click(); await settle(); }); }
async function type(host, value) {
  await act(async () => {
    const input = host.querySelector("#quote-task-list-name");
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

test("cards share one GET and authoritative save versions while preserving each other's drafts", async () => {
  let current = initial, gets = 0;
  const patches = [];
  const view = await mount(async (_url, options) => {
    assert.equal(options.headers["X-Tenant-Id"], "tenant-a");
    if (options?.method !== "PATCH") { gets++; return current; }
    const patch = JSON.parse(options.body); patches.push(patch);
    const { expectedVersion, ...changes } = patch;
    assert.equal(expectedVersion, current.version);
    current = { ...current, ...changes, version: current.version + 1 };
    return current;
  });
  try {
    assert.equal(gets, 1, "real QueryClient deduplicates both cards");
    await type(view.host, "Delivery draft");
    await click(view.host.querySelectorAll('input[type="checkbox"]')[0]);
    await click(button(view.host, "Save catalogue visibility"));
    assert.equal(view.host.querySelector("#quote-task-list-name").value, "Delivery draft");
    await click(view.host.querySelectorAll('input[type="checkbox"]')[1]);
    await click(button(view.host, "Save task settings"));
    assert.equal(view.host.querySelectorAll('input[type="checkbox"]')[1].checked, false,
      "unsaved SKU draft survives task-card save");
    await click(button(view.host, "Save catalogue visibility"));
    assert.deepEqual(patches, [
      { showInternalCode: false, expectedVersion: 1 },
      { quoteTaskListName: "Delivery draft", expectedVersion: 2 },
      { showSku: false, expectedVersion: 3 },
    ]);
    assert.equal(current.showInternalCode, false);
    assert.equal(current.showSku, false);
    assert.equal(gets, 1);
  } finally { await view.close(); }
});

test("visibility conflict refetch updates shared version but retains explicit false draft for retry", async () => {
  let current = initial, gets = 0, conflict = true;
  const patches = [];
  const view = await mount(async (_url, options) => {
    if (options?.method !== "PATCH") { gets++; return current; }
    const patch = JSON.parse(options.body); patches.push(patch);
    if (conflict) {
      conflict = false; current = { ...initial, version: 7, quoteTaskListName: "Remote tasks" };
      throw Object.assign(new Error("Version conflict"), { status: 409 });
    }
    return { ...current, showSku: patch.showSku, version: 8 };
  });
  try {
    await click(view.host.querySelectorAll('input[type="checkbox"]')[1]);
    await click(button(view.host, "Save catalogue visibility"));
    await act(settle);
    assert.equal(gets, 2);
    assert.match(view.host.querySelector('[role="alert"]').textContent, /Version conflict.*choices are retained/);
    assert.equal(view.host.querySelectorAll('input[type="checkbox"]')[1].checked, false);
    assert.equal(view.host.querySelector("#quote-task-list-name").value, "Remote tasks");
    await click(button(view.host, "Save catalogue visibility"));
    assert.deepEqual(patches, [{ showSku: false, expectedVersion: 1 }, { showSku: false, expectedVersion: 7 }]);
    assert.match(view.host.textContent, /Catalogue visibility saved/);
  } finally { await view.close(); }
});

test("tenant switch clears drafts and hides prior tenant data until new settings resolve", async () => {
  let resolveTenantB;
  const view = await mount(async () => fixture.getActiveTenantId() === "tenant-a" ? initial
    : new Promise(resolve => { resolveTenantB = resolve; }));
  try {
    await type(view.host, "Tenant A secret draft");
    await click(view.host.querySelector('input[type="checkbox"]'));
    await act(async () => { fixture.setActiveTenantId("tenant-b"); await settle(); });
    assert.match(view.host.textContent, /Loading catalogue settings/);
    assert.match(view.host.textContent, /Loading task settings/);
    assert.equal(view.host.querySelector("input"), null);
    await act(async () => { resolveTenantB({ ...initial, version: 12, quoteTaskListName: "Tenant B", showSku: false }); await settle(); });
    await act(settle);
    assert.equal(view.host.querySelector("#quote-task-list-name").value, "Tenant B");
    assert.equal(view.host.querySelectorAll('input[type="checkbox"]')[0].checked, true);
    assert.equal(view.host.querySelectorAll('input[type="checkbox"]')[1].checked, false);
    assert.equal(button(view.host, "Save catalogue visibility").disabled, true);
  } finally { await view.close(); }
});

test("loading/error and incomplete migration fail closed, retry restores read-only controls", async () => {
  let respond, gets = 0;
  const view = await mount(async () => { gets++; return new Promise(resolve => { respond = resolve; }); },
    { canManage: false, both: false });
  try {
    assert.match(view.host.textContent, /Loading catalogue settings/);
    assert.equal(view.host.querySelector("input"), null);
    await act(async () => { respond({ version: 1, showInternalCode: true }); await settle(); });
    await act(settle);
    assert.match(view.host.querySelector('[role="alert"]').textContent, /incomplete/);
    assert.equal(view.host.querySelector("input"), null);
    await click(button(view.host, "Retry"));
    assert.equal(gets, 2);
    await act(async () => { respond({ ...initial, showInternalCode: false }); await settle(); });
    await act(settle);
    assert.equal(view.host.querySelector('input[type="checkbox"]').checked, false);
    assert.ok([...view.host.querySelectorAll("input")].every(input => input.disabled));
    assert.equal(button(view.host, "Save catalogue visibility"), undefined);
  } finally { await view.close(); }
});

test("network errors are visible and never render stale settings as editable", async () => {
  const view = await mount(async () => { throw new Error("Settings service unavailable"); }, { both: false });
  try {
    assert.match(view.host.querySelector('[role="alert"]').textContent, /Settings service unavailable/);
    assert.equal(view.host.querySelector("input"), null);
    assert.ok(button(view.host, "Retry"));
  } finally { await view.close(); }
});

test("failed background refresh preserves both drafts read-only; retry refreshes the shared save version", async () => {
  let current = initial, failRead = false;
  const patches = [];
  const view = await mount(async (_url, options) => {
    if (options?.method !== "PATCH") {
      if (failRead) throw new Error("Background settings unavailable");
      return current;
    }
    const patch = JSON.parse(options.body); patches.push(patch);
    const { expectedVersion, ...changes } = patch;
    assert.equal(expectedVersion, current.version);
    current = { ...current, ...changes, version: current.version + 1 };
    return current;
  });
  try {
    await type(view.host, "Retained task draft");
    await click(view.host.querySelectorAll('input[type="checkbox"]')[1]);
    failRead = true;
    await act(async () => {
      await view.client.refetchQueries({ queryKey: ["sales-settings"] });
      await settle();
    });
    await act(settle);
    assert.equal(view.host.querySelector("#quote-task-list-name").value, "Retained task draft");
    assert.equal(view.host.querySelectorAll('input[type="checkbox"]')[1].checked, false);
    assert.ok([...view.host.querySelectorAll("input")].every(input => input.disabled));
    assert.equal(button(view.host, "Save task settings"), undefined);
    assert.equal(button(view.host, "Save catalogue visibility"), undefined);
    assert.equal(view.host.querySelectorAll('[role="alert"]').length, 2);
    assert.match(view.host.textContent, /Background settings unavailable/);
    assert.deepEqual(patches, []);

    failRead = false;
    current = { ...initial, version: 9, showInternalCode: false, quoteTaskListName: "Remote name" };
    await click(button(view.host, "Retry"));
    await act(settle);
    assert.equal(view.host.querySelector("#quote-task-list-name").value, "Retained task draft");
    assert.equal(view.host.querySelectorAll('input[type="checkbox"]')[0].checked, false);
    assert.equal(view.host.querySelectorAll('input[type="checkbox"]')[1].checked, false);
    assert.ok([...view.host.querySelectorAll("input")].every(input => !input.disabled));
    await click(button(view.host, "Save catalogue visibility"));
    assert.equal(view.host.querySelector("#quote-task-list-name").value, "Retained task draft");
    await click(button(view.host, "Save task settings"));
    assert.deepEqual(patches, [
      { showSku: false, expectedVersion: 9 },
      { quoteTaskListName: "Retained task draft", expectedVersion: 10 },
    ]);
  } finally { await view.close(); }
});

test("successful save cancels an older in-flight GET so its late result cannot replace the saved version", async () => {
  let reads = 0, resolveOldRead, oldSignal;
  const view = await mount(async (_url, options) => {
    if (options?.method === "PATCH") return { ...initial, showSku: false, version: 2 };
    if (++reads === 1) return initial;
    oldSignal = options.signal;
    return new Promise(resolve => { resolveOldRead = resolve; });
  });
  try {
    await click(view.host.querySelectorAll('input[type="checkbox"]')[1]);
    let refreshing;
    await act(async () => {
      refreshing = view.client.refetchQueries({ queryKey: ["sales-settings"] });
      await settle();
    });
    await click(button(view.host, "Save catalogue visibility"));
    assert.equal(oldSignal.aborted, true);
    await act(async () => { resolveOldRead(initial); await refreshing; await settle(); });
    assert.equal(view.host.querySelectorAll('input[type="checkbox"]')[1].checked, false);
    const cached = view.client.getQueriesData({ queryKey: ["sales-settings"] })[0][1];
    assert.equal(cached.version, 2);
    assert.equal(cached.showSku, false);
  } finally { await view.close(); }
});
