import test, { after } from "node:test";
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
after(() => dom.window.close());
const compiled = await build({
  stdin: { contents: `export {default as Card} from "./client/src/components/sales/QuoteTaskSettings";
    export {default as Naming} from "./client/src/components/sales/QuoteNamingSettings";
    export {default as Catalogue} from "./client/src/components/sales/CatalogueVisibilitySettings";
    export {default as Context} from "./client/src/contexts/LayoutContext";`, resolveDir: process.cwd(), loader: "jsx" },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs",
  jsx: "automatic", alias: { "@": `${process.cwd()}/client/src`, "@shared": `${process.cwd()}/shared` },
  plugins: [{ name: "tenant-store", setup(build) {
    build.onResolve({ filter: /base44Client$/ }, () => ({ path: "tenant", namespace: "fixture" }));
    build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
      contents: "export const getActiveTenantId=()=> globalThis.settingsScopeTenant || 'tenant-a'; export const subscribeToActiveTenantId=()=>()=>{};",
    }));
  } }],
});
const mod = new Module(`${process.cwd()}/settings-scope-test.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(compiled.outputFiles[0].text, `${process.cwd()}/settings-scope-test.cjs`);
const settings = { version: 1, quoteTaskListName: "Quote tasks", showInternalCode: true, showSku: true };
const settle = () => new Promise(resolve => setTimeout(resolve, 35));

async function mount(request, canManage = true, authResolved = true, card = "Card") {
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity },
  } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(QueryClientProvider, { client },
      React.createElement(mod.exports.Context.Provider, { value: { authResolved, sessionValidated: true } },
        card === "All"
          ? React.createElement(React.Fragment, null, ...["Naming", "Card", "Catalogue"].map(name => React.createElement(mod.exports[name], { key: name, canManage, request })))
          : React.createElement(mod.exports[card], { canManage, request }))));
    await settle();
  });
  await act(settle);
  return { host, client, async close() {
    await act(async () => root.unmount()); client.clear(); host.remove();
  } };
}
async function type(host, value) {
  await act(async () => {
    const input = host.querySelector("input");
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

test("task-list settings load through the shared scoped query and save the trimmed name/version", async () => {
  const calls = [];
  const fixture = await mount(async (_url, options) => {
    if (options?.method !== "PATCH") return settings;
    calls.push(JSON.parse(options.body));
    assert.equal(options.headers["X-Tenant-Id"], "tenant-a");
    return { ...settings, version: 2, quoteTaskListName: "Delivery" };
  });
  try {
    assert.equal(fixture.host.querySelector("input").value, "Quote tasks");
    await type(fixture.host, " Delivery ");
    await act(async () => { fixture.host.querySelector('button[type="submit"]').click(); await settle(); });
    assert.deepEqual(calls, [{ expectedVersion: 1, quoteTaskListName: "Delivery" }]);
    assert.equal(fixture.host.querySelector("input").value, "Delivery");
    assert.equal(fixture.host.querySelector('button[type="submit"]').disabled, true);
    assert.equal(fixture.client.getQueriesData({ queryKey: ["sales-settings"] })[0][1].version, 2);
  } finally { await fixture.close(); }
});

test("task-list conflict refetch retains the draft and retry uses the new version", async () => {
  let current = settings, conflict = true;
  const patches = [];
  const fixture = await mount(async (_url, options) => {
    if (options?.method !== "PATCH") return current;
    const patch = JSON.parse(options.body); patches.push(patch);
    if (conflict) {
      conflict = false; current = { ...settings, version: 4, showSku: false };
      throw Object.assign(new Error("Settings changed"), { status: 409 });
    }
    return { ...current, quoteTaskListName: patch.quoteTaskListName, version: 5 };
  });
  try {
    await type(fixture.host, "My draft");
    await act(async () => { fixture.host.querySelector('button[type="submit"]').click(); await settle(); });
    await act(settle);
    assert.match(fixture.host.querySelector('[role="alert"]').textContent, /Settings changed/);
    assert.equal(fixture.host.querySelector("input").value, "My draft");
    await act(async () => { fixture.host.querySelector('button[type="submit"]').click(); await settle(); });
    assert.deepEqual(patches.map(p => p.expectedVersion), [1, 4]);
    assert.equal(fixture.host.querySelector("input").value, "My draft");
  } finally { await fixture.close(); }
});

test("task-list viewer is read-only and unresolved authentication makes no request", async () => {
  const viewer = await mount(async () => settings, false);
  try {
    assert.equal(viewer.host.querySelector("input").disabled, true);
    assert.equal(viewer.host.querySelector("button"), null);
  } finally { await viewer.close(); }
  const pending = await mount(() => assert.fail("unresolved auth must not fetch"), true, false);
  try {
    assert.match(pending.host.textContent, /Loading task settings/);
    assert.equal(pending.host.querySelector("input"), null);
  } finally { await pending.close(); }
});

for (const card of ["Card", "Naming"]) {
  test(`${card} uses the canonical guarded patch and refuses writes after the active tenant changes`, async () => {
    const patches = [];
    const fixture = await mount(async (_url, options) => {
      if (options?.method !== "PATCH") return settings;
      patches.push(options);
      return { ...settings, version: 2 };
    }, true, true, card);
    try {
      await type(fixture.host, "Private draft");
      // No React rerender: this exercises the authority's submission-time
      // tenant check rather than merely relying on disabled controls.
      globalThis.settingsScopeTenant = "tenant-b";
      await act(async () => {
        fixture.host.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
        await settle();
      });
      assert.equal(patches.length, 0);
      assert.match(fixture.host.querySelector('[role="alert"]').textContent, /tenant or session changed/);
      assert.equal(fixture.host.querySelector("input").value, "Private draft");
    } finally {
      delete globalThis.settingsScopeTenant;
      await fixture.close();
    }
  });
}

test("three settings cards share canonical discovery and accepted versions with independent dirty drafts", async () => {
  let current = { ...settings };
  let gets = 0;
  const patches = [];
  const fixture = await mount(async (_url, options) => {
    assert.equal(options.headers["X-Tenant-Id"], "tenant-a");
    if (options?.method !== "PATCH") { gets += 1; return current; }
    const { expectedVersion, ...patch } = JSON.parse(options.body);
    assert.equal(expectedVersion, current.version);
    patches.push({ expectedVersion, ...patch });
    current = { ...current, ...patch, version: current.version + 1 };
    return current;
  }, true, true, "All");
  try {
    const forms = fixture.host.querySelectorAll("form");
    const namingInput = forms[0].querySelector("input");
    const taskInput = forms[1].querySelector("input");
    const checkbox = forms[2].querySelector("input");
    assert.equal(gets, 1);
    await type(forms[0], "Proposal");
    await type(forms[1], "Private task list");
    await act(async () => checkbox.click());
    await act(async () => { forms[0].querySelector('button[type="submit"]').click(); await settle(); });
    assert.equal(patches[0].expectedVersion, 1);
    assert.equal(taskInput.value, "Private task list");
    assert.equal(checkbox.checked, false);
    await type(forms[0], "Estimate");
    await act(async () => { forms[2].querySelector('button[type="submit"]').click(); await settle(); });
    assert.deepEqual(patches[1], { expectedVersion: 2, showInternalCode: false });
    assert.equal(namingInput.value, "Estimate");
    assert.equal(taskInput.value, "Private task list");
    await act(async () => { forms[1].querySelector('button[type="submit"]').click(); await settle(); });
    assert.deepEqual(patches[2], { expectedVersion: 3, quoteTaskListName: "Private task list" });
    assert.equal(namingInput.value, "Estimate");
    assert.equal(fixture.host.querySelector("#quote-singular-name"), namingInput);
    assert.equal(fixture.host.querySelector("#quote-task-list-name"), taskInput);
    assert.equal(fixture.host.querySelector('input[type="checkbox"]'), checkbox);
    assert.equal(fixture.client.getQueriesData({ queryKey: ["sales-settings"] })[0][1].version, 4);
    assert.equal(gets, 1);
  } finally { await fixture.close(); }
});
