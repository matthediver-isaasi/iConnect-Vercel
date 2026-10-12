import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
const result = await build({ entryPoints: ["client/src/components/sales/OpportunitiesWorkspace.jsx"], bundle: true, write: false, platform: "node", format: "cjs", packages: "external", jsx: "automatic", loader: { ".css": "empty" }, alias: { "@": `${process.cwd()}/client/src`, "@shared": `${process.cwd()}/shared` },
  plugins: [{ name: "unrelated-page-dependencies", setup(b) {
    b.onResolve({ filter: /\/(base44Client|useMemberAccess|OpportunityProjectTasksPanel)$/ }, args => ({ path: args.path, namespace: "fixture" }));
    b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const base44 = {}; export const getActiveTenantId = () => 'fixture'; export const subscribeToActiveTenantId = () => () => {}; export const useMemberAccess = () => ({}); export default () => null;", loader: "js" }));
  } }],
});
const mod = new Module(`${process.cwd()}/contact-panel-fixture.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(result.outputFiles[0].text, mod.filename || `${process.cwd()}/contact-panel-fixture.cjs`);
const React = mod.require("react");
globalThis.React = React;
const { renderToString } = mod.require("react-dom/server");
const { QueryClient, QueryClientProvider } = mod.require("@tanstack/react-query");
test("contacts panel distinguishes loading, no organisation, empty and already assigned contacts", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = (props = {}) => renderToString(React.createElement(QueryClientProvider, { client },
    React.createElement(mod.exports.CollectionPanel, { type: "contacts", opportunityId: "opp", organizationId: "org", items: [], canEdit: true, onChanged() {}, ...props })));
  assert.match(render(), /Loading organisation contacts/);
  assert.match(render({ organizationId: null }), /No organisation is linked/);
  client.setQueryData(["opportunity-contact-options", "org"], []);
  assert.match(render(), /No contacts were found/);
  client.setQueryData(["opportunity-contact-options", "org"], [{ id: "person", first_name: "Example", organization_id: "org" }]);
  assert.match(render(), /Select existing organisation contact/);
  assert.match(render({ items: [{ id: "role-row", member_id: "person" }] }), /All organisation contacts are already added/);
  assert.doesNotMatch(render({ organizationId: "other-org" }), /All organisation contacts are already added/);
  client.getQueryCache().find({ queryKey: ["opportunity-contact-options", "org"], exact: true })
    .setState({ status: "error", error: new Error("Contact lookup failed") });
  assert.match(render(), /Contact lookup failed/);
  assert.match(render(), /Retry/);
  assert.doesNotMatch(render({ canEdit: false }), /Organisation contact/);
  client.clear();
});

test("document upload stays visibly pending through transfer and list refresh, then allows retry after failure", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://fixture.invalid" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = mod.require("react-dom/client");
  const { act } = React;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false, gcTime: 0 } } });
  const root = createRoot(document.getElementById("root"));
  const originalFetch = globalThis.fetch;
  let releaseTransfer, releaseRefresh;
  const transfer = new Promise(resolve => { releaseTransfer = resolve; });
  const refresh = new Promise(resolve => { releaseRefresh = resolve; });
  let fail = false, refreshed = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("signed-upload-url")) return new Response(JSON.stringify({ signedUrl: "https://fixture.invalid/upload", bucket: "private", path: "example.pdf" }));
    if (options.method === "PUT") {
      if (fail) return new Response("", { status: 500 });
      await transfer;
      return new Response("");
    }
    assert.match(String(url), /resource=documents/);
    return new Response(JSON.stringify({ id: "doc" }));
  };
  function Harness() {
    const [items, setItems] = React.useState([]);
    return React.createElement(mod.exports.DocumentsPanel, { opportunityId: "opp", items, canEdit: true,
      onChanged: async () => { refreshed++; await refresh; setItems([{ id: "doc", name: "example.pdf", url: "/document" }]); } });
  }
  const wait = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
  const selectFile = async () => {
    const input = document.querySelector('input[type="file"]');
    Object.defineProperty(input, "files", { configurable: true, value: [new dom.window.File(["test"], "example.pdf", { type: "application/pdf" })] });
    await act(async () => { input.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    await wait();
    return input;
  };
  try {
    await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Harness))));
    const input = await selectFile();
    assert.equal(input.disabled, true);
    assert.match(document.querySelector('[role="status"]').textContent, /Uploading example\.pdf/);
    releaseTransfer(); await wait();
    assert.equal(refreshed, 1);
    assert.equal(input.disabled, true, "list refresh must finish before success");
    releaseRefresh(); await wait();
    assert.equal(input.disabled, false);
    assert.equal(document.querySelector('[role="status"]'), null);
    assert.match(document.body.textContent, /example\.pdf/);
    fail = true;
    await selectFile();
    assert.equal(input.disabled, false);
    assert.match(document.querySelector('[role="alert"]').textContent, /Upload failed.*retry/);
    assert.equal(refreshed, 1, "failed transfer must not create a document");
  } finally {
    releaseTransfer(); releaseRefresh();
    await act(async () => root.unmount());
    client.clear(); globalThis.fetch = originalFetch; dom.window.close();
  }
});
