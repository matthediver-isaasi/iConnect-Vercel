import test, { after } from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = createRequire(import.meta.url)("@tanstack/react-query");
after(() => dom.window.close());

const compiled = await build({
  stdin: { contents: `
    export {default as Settings} from "./client/src/components/sales/PartnershipTermsSettings";
    export {default as Editor} from "./client/src/components/sales/AgreementLegalEditor";
    export {default as Context} from "./client/src/contexts/LayoutContext";
    export {setTenant} from "@/api/base44Client";`, resolveDir: process.cwd(), loader: "jsx" },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  alias: { "@": `${process.cwd()}/client/src` },
  plugins: [{ name: "fixtures", setup(builder) {
    builder.onResolve({ filter: /base44Client$/ }, () => ({ path: "tenant", namespace: "fixture" }));
    builder.onResolve({ filter: /^@tiptap\/react$/ }, () => ({ path: "editor", namespace: "fixture" }));
    builder.onResolve({ filter: /\/AgreementDocument$|^\.\/AgreementDocument$/ }, () => ({ path: "document", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ loader: "jsx", resolveDir: process.cwd(), contents: path === "tenant" ? `
      let tenant="tenant-a"; const listeners=new Set();
      export const getActiveTenantId=()=>tenant;
      export const subscribeToActiveTenantId=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
      export const setTenant=value=>{tenant=value;listeners.forEach(fn=>fn())};
    ` : path === "document" ? `export const LegalContent=({html})=><div>{html}</div>;` : `
      import {useRef,useState} from "react";
      export function useEditor(options) {
        const ref=useRef(); const [,render]=useState(0);
        if(!ref.current) {
          const editor={html:options.content,editable:options.editable,isActive:()=>false};
          editor.getHTML=()=>editor.html;
          editor.commands={setEditable:value=>{editor.editable=value;render(x=>x+1)},
            setContent:value=>{editor.html=value;render(x=>x+1)}};
          editor.setEditable=editor.commands.setEditable;
          editor.change=value=>{editor.html=value;options.onUpdate({editor});render(x=>x+1)};
          editor.chain=()=>({focus(){return this},insertContent(value){editor.change(editor.html+value);return this},run(){}});
          ref.current=editor;
        }
        return ref.current;
      }
      export const EditorContent=({editor})=><textarea aria-label="Test rich text" disabled={!editor.editable}
        value={editor.html} onChange={event=>editor.change(event.target.value)}/>;
    ` }));
  } }],
});
const mod = new Module(`${process.cwd()}/partnership-settings-test.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(compiled.outputFiles[0].text, `${process.cwd()}/partnership-settings-test.cjs`);
const fixture = mod.exports;
const initial = { version: 1, showSku: true, showInternalCode: true, partnershipTermsHtml: "<p>Tenant terms</p>" };
const settle = () => new Promise(resolve => setTimeout(resolve, 40));
const button = (host, label) => [...host.querySelectorAll("button")].find(node => node.textContent === label);
async function click(node) { assert.ok(node); await act(async () => { node.click(); await settle(); }); }
async function type(host, value) {
  await act(async () => {
    const input = host.querySelector("textarea");
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
async function mount(request, { canManage = true, documentMode = false } = {}) {
  fixture.setTenant("tenant-a");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  function Document() {
    const [value, setValue] = React.useState("<p>Existing snapshot</p>");
    return React.createElement(fixture.Editor, { value, onChange: setValue });
  }
  await act(async () => {
    root.render(React.createElement(QueryClientProvider, { client },
      React.createElement(fixture.Context.Provider, { value: { authResolved: true, sessionValidated: true } },
        documentMode ? React.createElement(Document) : React.createElement(fixture.Settings, { canManage, request }))));
    await settle();
  });
  await act(settle);
  return { host, client, async close() { await act(async () => root.unmount()); client.clear(); host.remove(); } };
}

test("template editing uses one settings query, preserves a conflicting draft and retries with the latest CAS version", async () => {
  let current = initial, gets = 0, conflict = true;
  const patches = [];
  const view = await mount(async (_path, options) => {
    if (options.method !== "PATCH") { gets++; return current; }
    const patch = JSON.parse(options.body); patches.push(patch);
    if (conflict) {
      conflict = false; current = { ...initial, version: 4, partnershipTermsHtml: "<p>Other edit</p>" };
      throw Object.assign(new Error("Conflict"), { status: 409 });
    }
    return { ...current, version: 5, partnershipTermsHtml: patch.partnershipTermsHtml };
  });
  try {
    assert.equal(gets, 1);
    assert.equal(button(view.host, "Insert standard partnership terms"), undefined);
    await type(view.host, "<p>Local draft</p>");
    await click(button(view.host, "Save standard terms"));
    await act(settle);
    assert.match(view.host.textContent, /Your edits are preserved/);
    assert.equal(view.host.querySelector("textarea").value, "<p>Local draft</p>");
    await click(button(view.host, "Retry saving standard terms"));
    assert.deepEqual(patches, [
      { expectedVersion: 1, partnershipTermsHtml: "<p>Local draft</p>" },
      { expectedVersion: 4, partnershipTermsHtml: "<p>Local draft</p>" },
    ]);
    assert.match(view.host.textContent, /Standard partnership terms saved/);
  } finally { await view.close(); }
});

test("unrelated cache updates preserve dirty terms; tenant switches reset the draft", async () => {
  const view = await mount(async () => initial);
  try {
    await type(view.host, "<p>Private draft</p>");
    await act(async () => {
      view.client.setQueriesData({ queryKey: ["sales-settings"] }, old => ({ ...old, version: 2, showSku: false }));
    });
    assert.equal(view.host.querySelector("textarea").value, "<p>Private draft</p>");
    await act(async () => { fixture.setTenant("tenant-b"); await settle(); });
    await act(settle);
    assert.equal(view.host.querySelector("textarea").value, initial.partnershipTermsHtml);
  } finally { await view.close(); }
});

test("viewers cannot edit or save terms", async () => {
  const view = await mount(async () => initial, { canManage: false });
  try {
    assert.equal(view.host.querySelector("textarea").disabled, true);
    assert.equal(button(view.host, "Save standard terms"), undefined);
    assert.match(view.host.textContent, /permission to manage Sales settings/);
  } finally { await view.close(); }
});

test("insertion uses the current saved tenant template and leaves the inserted snapshot unchanged after later updates", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => initial });
  const view = await mount(null, { documentMode: true });
  try {
    assert.equal(view.host.querySelector("textarea").value, "<p>Existing snapshot</p>");
    await act(async () => {
      view.client.setQueriesData({ queryKey: ["sales-settings"] }, old => ({ ...old, version: 2, partnershipTermsHtml: "<p>Current saved terms</p>" }));
    });
    await click(button(view.host, "Insert standard partnership terms"));
    await click(button(view.host, "Insert saved terms"));
    const snapshot = "<p>Existing snapshot</p><p>Current saved terms</p>";
    assert.equal(view.host.querySelector("textarea").value, snapshot);
    await act(async () => {
      view.client.setQueriesData({ queryKey: ["sales-settings"] }, old => ({ ...old, version: 3, partnershipTermsHtml: "<p>Later revision</p>" }));
    });
    assert.equal(view.host.querySelector("textarea").value, snapshot);
  } finally { await view.close(); globalThis.fetch = previousFetch; }
});

for (const state of ["empty", "error", "loading"]) {
  test(`${state} tenant settings disable insertion and explain where to manage the template`, async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = state === "loading" ? () => new Promise(() => {})
      : async () => ({ ok: state !== "error", status: 503,
        json: async () => state === "error" ? { message: "Unavailable" } : { ...initial, partnershipTermsHtml: "" } });
    const view = await mount(null, { documentMode: true });
    try {
      assert.equal(button(view.host, "Insert standard partnership terms").disabled, true);
      assert.match(view.host.textContent, /Sales settings → Standard partnership terms/);
      assert.equal(view.host.querySelector("textarea").value, "<p>Existing snapshot</p>");
    } finally { await view.close(); globalThis.fetch = previousFetch; }
  });
}
