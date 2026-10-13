import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// Keep the real dialog, CRM helper and paginating API adapter. Replace only
// unrelated panels and visual primitives so interactions run without a browser.
const result = await build({
  entryPoints: ["client/src/components/sales/OpportunitiesWorkspace.jsx"],
  bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
  jsx: "automatic", loader: { ".css": "empty" },
  alias: { "@": `${process.cwd()}/client/src`, "@shared": `${process.cwd()}/shared` },
  plugins: [{ name: "dialog-fixtures", setup(b) {
    b.onResolve({ filter: /\/(useMemberAccess|OpportunityProjectTasksPanel|use-toast|dialog|select)$/ }, args => ({ path: args.path, namespace: "fixture" }));
    b.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({
      loader: "jsx", resolveDir: process.cwd(), contents: args.path.endsWith("/select") ? `
        import React from 'react';
        export const Select = ({children,value,onValueChange,disabled}) => <select disabled={disabled} value={value} onChange={e=>onValueChange(e.target.value)}>{children}</select>;
        export const SelectItem = ({children,value}) => <option value={value}>{children}</option>;
        export const SelectTrigger = () => null;
        export const SelectValue = () => null;
        export const SelectContent = ({children}) => <>{children}</>;
      ` : args.path.endsWith("/dialog") ? `
        import React from 'react';
        export const Dialog = ({open,children}) => open ? <div>{children}</div> : null;
        export const DialogContent = ({children}) => <div>{children}</div>;
        export const DialogHeader = DialogContent, DialogFooter = DialogContent, DialogTitle = DialogContent, DialogDescription = DialogContent;
      ` : `export const useMemberAccess = () => ({}); export const useToast = () => ({toast() {}}); export default () => null;`,
    }));
  } }],
});
const mod = new Module(`${process.cwd()}/opportunity-org-fixture.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
const dom = new JSDOM("<div id='root'></div>", { url: "https://fixture.invalid" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
mod._compile(result.outputFiles[0].text, mod.id);
const React = mod.require("react");
globalThis.React = React;
const { QueryClient, QueryClientProvider } = mod.require("@tanstack/react-query");

test("dialog loads every status and page, creates with non-live organisation/contact, retries failures and ignores stale loads", async () => {
  const { createRoot } = mod.require("react-dom/client");
  const { act } = React;
  const root = createRoot(document.getElementById("root"));
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: 0 } } });
  const originalFetch = globalThis.fetch;
  const rows = Array.from({ length: 1002 }, (_, i) => ({
    id: `org-${String(i).padStart(4, "0")}`, name: i < 1001 ? "Same name" : "Z organisation",
    application_status: ["Live", "Pending", null][i % 3],
  }));
  let mode = "normal", created, submitted, releaseStale, staleSignal;
  const pages = [];
  globalThis.fetch = async (path, options = {}) => {
    const url = new URL(path, "https://fixture.invalid");
    if (url.pathname === "/api/entities/Organization") {
      assert.equal(url.searchParams.get("skipDirectoryFilters"), "true");
      assert.deepEqual(JSON.parse(url.searchParams.get("sort")), { name: "asc", id: "asc" });
      const offset = Number(url.searchParams.get("offset"));
      pages.push(offset);
      if (mode === "fail") return new Response(JSON.stringify({ error: "Lookup unavailable" }), { status: 500 });
      if (mode === "stale") {
        staleSignal = options.signal;
        return new Promise(resolve => { releaseStale = () => resolve(new Response(JSON.stringify([{ id: "stale", name: "Stale result" }]))); });
      }
      return new Response(JSON.stringify(mode === "empty" ? [] : rows.slice(offset, offset + 1000)));
    }
    if (url.pathname === "/api/opportunities/contacts") {
      return new Response(JSON.stringify({ items: [{ id: "contact", first_name: "Contact", organization_id: url.searchParams.get("organizationId") }], nextOffset: null }));
    }
    assert.equal(url.pathname, "/api/opportunities");
    submitted = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: "created", organization_id: submitted.organizationId, primary_contact_id: submitted.contactId }), { status: 201 });
  };
  const render = async (open = true) => act(async () => root.render(
    React.createElement(QueryClientProvider, { client }, React.createElement(mod.exports.OpportunityDialog, {
      open, onOpenChange() {}, stages: [{ id: "stage", name: "Open" }], onCreated(value) { created = value; },
    }))));
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const select = async (index, value) => act(async () => {
    const input = document.querySelectorAll("select")[index];
    input.value = value;
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  try {
    await render(); await settle();
    assert.deepEqual(pages, [0, 1000]);
    assert.equal(document.querySelector("select").options.length, 1002);
    await select(0, "org-1000"); await settle(); // Pending, on page two
    await select(1, "contact");
    await select(0, "org-0002"); await settle();
    assert.equal(document.querySelectorAll("select")[1].value, "none", "organisation change clears contact");
    await select(0, "org-1000"); await settle(); await select(1, "contact");
    await act(async () => {
      const input = document.querySelector("#opp-name");
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, "New sale");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    const createButton = [...document.querySelectorAll("button")].find(b => b.textContent === "Create");
    assert.equal(createButton.disabled, false);
    await act(async () => createButton.click());
    await settle();
    assert.equal(created.organization_id, "org-1000");
    assert.equal(submitted.contactId, "contact");

    await render(false); mode = "fail"; await render(); await settle();
    assert.match(document.querySelector('[role="alert"]').textContent, /Lookup unavailable/);
    assert.doesNotMatch(document.body.textContent, /No organisations are available/);
    mode = "empty";
    await act(async () => [...document.querySelectorAll("button")].find(b => b.textContent === "Retry").click());
    await settle();
    assert.match(document.body.textContent, /No organisations are available/);
    await render(false); mode = "stale"; await render(); await settle();
    await render(false);
    assert.equal(staleSignal.aborted, true);
    mode = "normal"; await render(); await settle();
    await act(async () => releaseStale()); await settle();
    assert.equal(document.querySelector("select").options.length, 1002);
    assert.doesNotMatch(document.body.textContent, /Stale result/);
  } finally {
    await act(async () => root.unmount());
    client.clear(); globalThis.fetch = originalFetch; dom.window.close();
  }
});
