import test, { after } from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { SALES_AUTOMATIC_COMMUNICATIONS } from "../../../../shared/salesCommunicationPolicy.js";

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
  entryPoints: ["client/src/components/sales/OpportunitySilentMode.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  alias: { "@shared": `${process.cwd()}/shared` },
  plugins: [{ name: "silent-mode-ui", setup(builder) {
    builder.onResolve({ filter: /^@\/components\/ui\// }, args => ({ path: args.path, namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
      contents: `
        import React from "react";
        export const Button=({children,variant,...props})=><button {...props}>{children}</button>;
        export const Card=({children,...props})=><section {...props}>{children}</section>;
        export const CardContent=({children,...props})=><div {...props}>{children}</div>;
        export const CardHeader=CardContent;
        export const CardTitle=({children})=><h3>{children}</h3>;
      `, loader: "jsx", resolveDir: process.cwd(),
    }));
  } }],
});
const mod = new Module(`${process.cwd()}/silent-mode-mounted-test.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(compiled.outputFiles[0].text, `${process.cwd()}/silent-mode-mounted-test.cjs`);
const Control = mod.exports.default;
const base = { id: "opportunity-fixture", version: 7, silent_mode: false, automatic_communications: [] };
const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
const click = async element => act(async () => element.click());
const saveButton = host => [...host.querySelectorAll("button")].find(element => element.textContent === "Save silent mode");
const toggle = host => host.querySelector("input");
const categories = host => [...host.querySelectorAll("fieldset input")];
async function mount(overrides = {}) {
  const calls = [];
  let refreshes = 0;
  let props = {
    opportunity: base, canEdit: true,
    request: async (path, options) => {
      const body = JSON.parse(options.body);
      calls.push({ path, ...options, body });
      return { ...base, version: 8, silent_mode: body.silentMode, automatic_communications: body.automaticCommunications };
    },
    onChanged: () => { refreshes++; },
    onReload: async () => ({ ...base, version: 9 }),
    ...overrides,
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
  const render = async patch => {
    props = { ...props, ...patch };
    await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Control, props))));
  };
  await render({});
  return { host, calls, render, refreshes: () => refreshes, close: async () => { await act(async () => root.unmount()); client.clear(); host.remove(); } };
}
after(() => dom.window.close());

test("off defaults to an empty allowlist; shared labelled categories are conditional and selections survive off/on", async () => {
  const f = await mount({ opportunity: { id: base.id, version: 7 } });
  try {
    assert.equal(toggle(f.host).checked, false);
    assert.equal(categories(f.host).length, 0);
    assert.equal(saveButton(f.host).disabled, true);
    assert.match(f.host.textContent, /normal automatic communication behaviour is preserved/);
    assert.match(f.host.textContent, /not replayed/);
    assert.match(f.host.textContent, /Manual sends and required signing verification are unchanged/);
    await click(toggle(f.host));
    assert.equal(categories(f.host).length, 4);
    SALES_AUTOMATIC_COMMUNICATIONS.forEach((item, i) => {
      assert.equal(categories(f.host)[i].checked, false);
      assert.match(categories(f.host)[i].closest("label").textContent, new RegExp(item.label));
      assert.ok(categories(f.host)[i].closest("label").textContent.includes(item.description));
    });
    assert.match(f.host.textContent, /normal trigger; saving never sends immediately/);
    await click(categories(f.host)[0]);
    await click(toggle(f.host));
    await click(toggle(f.host));
    assert.equal(categories(f.host)[0].checked, true);
    assert.equal(f.calls.length, 0);
    await click(saveButton(f.host)); await settle();
    assert.equal(f.calls[0].path, `/api/opportunities/${base.id}`);
    assert.equal(f.calls[0].method, "PATCH");
    assert.deepEqual(f.calls[0].body, { action: "silent-mode", expectedVersion: 7, silentMode: true, automaticCommunications: [SALES_AUTOMATIC_COMMUNICATIONS[0].id] });
    assert.equal(f.refreshes(), 1);
    assert.match(f.host.querySelector('[role="status"]').textContent, /saved.*No communications were sent/);
    assert.equal(saveButton(f.host).disabled, true);
  } finally { await f.close(); }
});

test("saving off retains the server selections and all categories can be permitted", async () => {
  const all = SALES_AUTOMATIC_COMMUNICATIONS.map(item => item.id);
  const f = await mount({ opportunity: { ...base, silent_mode: true, automatic_communications: all } });
  try {
    assert.ok(categories(f.host).every(input => input.checked));
    await click(toggle(f.host));
    await click(saveButton(f.host)); await settle();
    assert.deepEqual(f.calls[0].body.automaticCommunications, all);
    assert.equal(f.calls[0].body.silentMode, false);
    await click(toggle(f.host));
    await click(saveButton(f.host)); await settle();
    assert.equal(f.calls[1].body.expectedVersion, 8);
    assert.equal(f.calls[1].body.silentMode, true);
  } finally { await f.close(); }
});

test("ordinary errors preserve the draft and original version through background refresh and allow retry", async () => {
  const bodies = [];
  const f = await mount({ request: async (_path, options) => {
    bodies.push(JSON.parse(options.body));
    throw new Error("Connection interrupted");
  } });
  try {
    await click(toggle(f.host));
    await click(categories(f.host)[2]);
    await click(saveButton(f.host)); await settle();
    assert.match(f.host.querySelector('[role="alert"]').textContent, /Connection interrupted.*selections have been kept/);
    await f.render({ opportunity: { ...base, version: 8 } });
    assert.equal(toggle(f.host).checked, true);
    assert.equal(categories(f.host)[2].checked, true);
    await click(saveButton(f.host)); await settle();
    assert.deepEqual(bodies[1], bodies[0]);
    assert.equal(f.refreshes(), 0);
  } finally { await f.close(); }
});

test("409 and 412 conflicts reload authoritative settings before the next save", async () => {
  for (const status of [409, 412]) {
    let reloads = 0;
    const bodies = [];
    const f = await mount({
      request: async (_path, options) => { bodies.push(JSON.parse(options.body)); throw Object.assign(new Error("Conflict"), { status }); },
      onReload: async () => { reloads++; return { ...base, version: 13, silent_mode: true, automatic_communications: ["invoice"] }; },
    });
    try {
      await click(toggle(f.host)); await click(saveButton(f.host)); await settle();
      assert.equal(reloads, 1);
      assert.match(f.host.textContent, /latest settings have been loaded/);
      assert.equal(categories(f.host)[2].checked, true);
      assert.equal(saveButton(f.host).disabled, true);
      await click(categories(f.host)[0]); await click(saveButton(f.host)); await settle();
      assert.equal(bodies[1].expectedVersion, 13);
    } finally { await f.close(); }
  }
});

test("failed conflict reload blocks stale saves and offers a working reload retry", async () => {
  let attempts = 0;
  const f = await mount({
    request: async () => { throw Object.assign(new Error("Conflict"), { status: 409 }); },
    onReload: async () => { if (++attempts === 1) throw new Error("Offline"); return { ...base, version: 14 }; },
  });
  try {
    await click(toggle(f.host)); await click(saveButton(f.host)); await settle();
    assert.equal(saveButton(f.host).disabled, true);
    assert.equal(toggle(f.host).disabled, true);
    assert.match(f.host.textContent, /Could not reload opportunity: Offline/);
    await click([...f.host.querySelectorAll("button")].find(button => button.textContent === "Reload latest settings"));
    await settle();
    assert.equal(toggle(f.host).checked, false);
    assert.equal(toggle(f.host).disabled, false);
    assert.equal(attempts, 2);
  } finally { await f.close(); }
});

test("read-only users see saved settings but cannot mutate; missing edit permission is denied", async () => {
  for (const canEdit of [false, undefined]) {
    const f = await mount({ canEdit, opportunity: { ...base, silent_mode: true, automatic_communications: ["invoice"] } });
    try {
      assert.equal(toggle(f.host).disabled, true);
      assert.equal(f.host.querySelector("fieldset").disabled, true);
      assert.equal(categories(f.host)[2].checked, true);
      assert.equal(saveButton(f.host), undefined);
      await click(toggle(f.host)); await click(categories(f.host)[0]);
      assert.equal(f.calls.length, 0);
      assert.match(f.host.textContent, /read-only access/);
    } finally { await f.close(); }
  }
});

test("pending saves disable edits and repeated submissions", async () => {
  let resolveSave;
  let calls = 0;
  const f = await mount({ request: () => { calls++; return new Promise(resolve => { resolveSave = resolve; }); } });
  try {
    await click(toggle(f.host)); await click(saveButton(f.host)); await settle();
    assert.equal(toggle(f.host).disabled, true);
    const pending = [...f.host.querySelectorAll("button")].find(button => button.textContent === "Saving…");
    assert.equal(pending.disabled, true);
    await click(pending);
    assert.equal(calls, 1);
    await act(async () => resolveSave({ ...base, version: 8, silent_mode: true }));
    await settle();
    assert.match(f.host.textContent, /Silent mode settings saved/);
  } finally { await f.close(); }
});

test("detail mounts the isolated control with explicit edit permission and existing request/refresh functions", () => {
  const source = readFileSync("client/src/components/sales/OpportunitiesWorkspace.jsx", "utf8");
  assert.match(source, /const canEditActiveOpportunity = canEdit === true && !archived/);
  assert.match(source, /<OpportunitySilentMode key=\{id\} opportunity=\{opportunity\} canEdit=\{canEditActiveOpportunity\} request=\{request\}/);
  assert.match(source, /onReload=\{async \(\) => \{ const result = await detail\.refetch\(\)/);
});
