import test, { after } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<html><body></body></html>", { url: "https://fixture.invalid/sales/proposals" });
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "MouseEvent", "Event"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = createRequire(import.meta.url)("@tanstack/react-query");

const uiStub = `
  import React from "react";
  export const Badge = ({children,...props}) => <span {...props}>{children}</span>;
  export const Button = ({children, variant, size, ...props}) => <button {...props}>{children}</button>;
  export const Card = ({children,...props}) => <section {...props}>{children}</section>;
  export const CardContent = ({children,...props}) => <div {...props}>{children}</div>;
  export const CardHeader = ({children,...props}) => <div {...props}>{children}</div>;
  export const CardTitle = ({children,...props}) => <h3 {...props}>{children}</h3>;
  export const Input = React.forwardRef((props, ref) => <input ref={ref} {...props}/>);
  export const Label = ({children,...props}) => <label {...props}>{children}</label>;
  const SelectContext = React.createContext({});
  export const Select = ({children,value,onValueChange}) => <SelectContext.Provider value={{value,onValueChange}}><select aria-label="select" value={value} onChange={event=>onValueChange(event.target.value)}>{children}</select></SelectContext.Provider>;
  export const SelectTrigger = () => null;
  export const SelectValue = () => null;
  export const SelectContent = ({children}) => children;
  export const SelectItem = ({children,value,...props}) => <option value={value} {...props}>{children}</option>;
  export const Tabs = ({children}) => <div>{children}</div>;
  export const TabsContent = ({children}) => <div>{children}</div>;
  export const TabsList = ({children}) => <div>{children}</div>;
  export const TabsTrigger = ({children}) => <button>{children}</button>;
  export const Textarea = props => <textarea {...props}/>;
  export const useToast = () => () => {};
`;
const symbols = [
  "bundlePreviewLines", "uniqueQuoteVersions", "clearOpportunityContacts", "opportunityContacts", "useQuoteOpportunity",
  "legalHtmlOf", "refreshSavedQuoteDraft", "quotePriceText", "quotePriceMinor", "quotePriceError",
  "persistedLineAmounts", "persistedQuoteAmounts", "persistedQuoteLineId", "providerTaxOptions",
  "quoteLineIdentityForSaving", "quoteLineTaxForSaving", "savedLineTaxCode", "taxCodeKey", "taxCodeLabel",
  "billingScheduleOf", "percentageInstalmentsForEditing", "percentageInstalmentsForSaving", "useSalesSettingsScope",
  "exhibitionSelectionPayload", "hasExhibitionHolds", "lineRequiresExhibition", "selectionsOf", "withExhibitionSelection",
  "useCatalogueTaxOptions",
];
const utilityStub = `export default (()=>null); ${symbols.map(name => `export const ${name} = ${name === "useSalesSettingsScope" ? "(()=>({ready:true,scopeKey:'scope'}))" : [
  "persistedQuoteAmounts", "persistedLineAmounts"
].includes(name) ? "(()=>({net:0,tax:0,gross:0}))" : [
  "percentageInstalmentsForEditing", "percentageInstalmentsForSaving", "uniqueQuoteVersions", "list"
].includes(name) ? "(()=>[])" : "(()=>null)"};`).join("\n")}`;
const built = await build({
  stdin: { contents: 'export { QuotesList } from "./client/src/components/sales/QuotesWorkspace.jsx";', resolveDir: process.cwd(), sourcefile: "QuotesList.test-entry.jsx", loader: "jsx" },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  alias: { "@": `${process.cwd()}/client/src`, "@shared": `${process.cwd()}/shared` },
  plugins: [{
    name: "quotes-list-fixtures",
    setup(builder) {
      builder.onResolve({ filter: /^@shared\/salesNaming\.js$/ }, () => ({ path: "naming-path", namespace: "fixture" }));
      builder.onResolve({ filter: /^@\// }, args => ({ path: args.path, namespace: "fixture" }));
      builder.onResolve({ filter: /^react-router-dom$/ }, () => ({ path: "router", namespace: "fixture" }));
      builder.onResolve({ filter: /^\.\// }, args => args.importer.endsWith("QuotesWorkspace.jsx") ? ({ path: args.path, namespace: "local-fixture" }) : undefined);
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => {
        if (args.path === "naming-path") return { contents: 'export const quotePath=(_n,id)=>id==="new"?"/sales/proposals/new":`/sales/proposals/${id}`;', resolveDir: process.cwd() };
        if (args.path === "router") return { contents: 'import React from "react"; export const Link=({children,...props})=><a {...props}>{children}</a>; export const useNavigate=()=>()=>{}; export const useLocation=()=>["/sales/proposals"]; export const useParams=()=>({});', loader: "jsx", resolveDir: process.cwd() };
        if (args.path.startsWith("@/components/ui/")) return { contents: uiStub, loader: "jsx", resolveDir: process.cwd() };
        if (args.path === "@/hooks/useSalesSettings") return { contents: 'export const useQuoteNaming=()=>({singular:"Proposal",plural:"Proposals",slug:"proposals"});', resolveDir: process.cwd() };
        if (args.path === "@/components/ui/use-toast") return { contents: 'export const useToast=()=>()=>{};', resolveDir: process.cwd() };
        return { contents: utilityStub, resolveDir: process.cwd() };
      });
      builder.onLoad({ filter: /.*/, namespace: "local-fixture" }, args => {
        if (args.path === "./quoteDisplayAmounts") return { contents: 'export const persistedLineAmounts=()=>({net:0,tax:0,gross:0}); export const persistedQuoteAmounts=()=>({net:0,tax:0,gross:0});', resolveDir: process.cwd() };
        return { contents: utilityStub, resolveDir: process.cwd() };
      });
    },
  }],
});
const compiledModule = new Module(`${process.cwd()}/quotes-workspace-mounted-fixture.cjs`);
compiledModule.paths = Module._nodeModulePaths(process.cwd());
compiledModule._compile(built.outputFiles[0].text, `${process.cwd()}/quotes-workspace-mounted-fixture.cjs`);
const QuotesList = compiledModule.exports.QuotesList;
const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
const click = async element => act(async () => element.click());
const activeRow = (archived = false, overrides = {}) => ({
  id: "proposal-17", row_version: 17, number: "P-017", status: "draft", currency: "GBP",
  archived_at: archived ? "2025-02-01T10:00:00Z" : null,
  ...overrides,
});
const rowActions = host => [...host.querySelectorAll("tr")].find(row => row.querySelector("td"))?.querySelectorAll("button") || [];

async function mount({ canManage = true, archived = false, mutationFailure = null } = {}) {
  const calls = [];
  const confirms = [];
  let confirmResult = true;
  let serverArchived = archived;
  let version = 17;
  let canManageValue = canManage;
  let rowPresent = true;
  const oldFetch = globalThis.fetch;
  const oldConfirm = dom.window.confirm;
  dom.window.confirm = message => { confirms.push(message); return confirmResult; };
  globalThis.fetch = async (path, options = {}) => {
    const url = new URL(path, "https://fixture.invalid");
    if (!options.method || options.method === "GET") {
      calls.push({ method: "GET", url: url.toString() });
      const wantsArchived = url.searchParams.get("archived") === "true";
      const items = rowPresent && wantsArchived === serverArchived ? [activeRow(serverArchived, { row_version: version })] : [];
      return new Response(JSON.stringify({ items, total: items.length, permissions: { canManage: canManageValue } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const body = JSON.parse(options.body || "{}");
    calls.push({ method: options.method, url: url.toString(), body });
    if (mutationFailure) return new Response(JSON.stringify(mutationFailure.payload || { message: mutationFailure.message }), { status: mutationFailure.status, headers: { "Content-Type": "application/json" } });
    if (options.method === "POST") {
      serverArchived = url.searchParams.get("action") === "archive";
      version++;
    } else if (options.method === "DELETE") rowPresent = false;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
  client.setQueryData(["sales-quote", "proposal-17", "scope"], { stale: true });
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(QuotesList))));
  await settle();
  return {
    host, calls, confirms, client,
    setConfirm: value => { confirmResult = value; },
    setCanManage: value => { canManageValue = value; },
    close: async () => {
      await act(async () => root.unmount());
      client.clear(); host.remove(); globalThis.fetch = oldFetch; dom.window.confirm = oldConfirm;
    },
  };
}
async function showArchived(fixture) {
  const filter = fixture.host.querySelector('select[aria-label="select"]');
  await act(async () => { filter.value = "archived"; filter.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  await settle();
}
after(() => dom.window.close());

test("active proposal archive sends POST with root row_version and archive warning; archived filter restores and permanently deletes", async () => {
  const fixture = await mount();
  try {
    const archive = [...rowActions(fixture.host)].find(button => button.textContent.includes("Archive"));
    assert.ok(archive);
    await click(archive); await settle();
    const post = fixture.calls.find(call => call.method === "POST");
    assert.equal(post.url, "https://fixture.invalid/api/sales/quotes/proposal-17?action=archive");
    assert.deepEqual(post.body, { expectedVersion: 17 });
    assert.match(fixture.confirms[0], /does not cancel payments, invoices, bookings or release reservations/);
    assert.equal(fixture.client.getQueryCache().find({ queryKey: ["sales-quote", "proposal-17"] }), undefined);

    const filter = fixture.host.querySelector('select[aria-label="select"]');
    await act(async () => { filter.value = "archived"; filter.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    await settle();
    assert.ok(fixture.calls.some(call => call.method === "GET" && new URL(call.url).searchParams.get("archived") === "true"));
    const restore = [...rowActions(fixture.host)].find(button => button.textContent.includes("Restore"));
    assert.ok(restore, "archived proposal exposes Restore");
    await click(restore); await settle();
    const restoreCall = fixture.calls.filter(call => call.method === "POST")[1];
    assert.equal(restoreCall.url, "https://fixture.invalid/api/sales/quotes/proposal-17?action=restore");
    assert.deepEqual(restoreCall.body, { expectedVersion: 18 });

    fixture.setConfirm(false);
    // Restore puts the record back in Active; choose Archived again through the filter after refresh.
    await act(async () => { filter.value = "active"; filter.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    await settle();
    // A cancellation must not issue a request.
    const countBefore = fixture.calls.filter(call => call.method === "POST" || call.method === "DELETE").length;
    await click([...rowActions(fixture.host)].find(button => button.textContent.includes("Archive")));
    assert.equal(fixture.calls.filter(call => call.method === "POST" || call.method === "DELETE").length, countBefore);
    assert.match(fixture.confirms.at(-1), /does not cancel payments/);
  } finally { await fixture.close(); }
});

test("permanent deletion sends expectedVersion and confirmDelete; cancelled confirmation never submits", async () => {
  const fixture = await mount({ archived: true });
  try {
    await showArchived(fixture);
    fixture.setConfirm(false);
    const deleteButton = [...rowActions(fixture.host)].find(button => button.textContent.includes("Delete permanently"));
    assert.ok(deleteButton);
    await click(deleteButton);
    assert.match(fixture.confirms[0], /Only unused drafts can be deleted.*irreversible/);
    assert.match(fixture.confirms[0], /delivery, signature, financial or inventory history cannot be deleted/);
    assert.equal(fixture.calls.some(call => call.method === "DELETE"), false);
    fixture.setConfirm(true);
    await click(deleteButton); await settle();
    const del = fixture.calls.find(call => call.method === "DELETE");
    assert.equal(del.url, "https://fixture.invalid/api/sales/quotes/proposal-17");
    assert.deepEqual(del.body, { expectedVersion: 17, confirmDelete: true });
  } finally { await fixture.close(); }
});

test("manage permission hides lifecycle controls and API blocker errors are shown to the user", async () => {
  const restricted = await mount({ canManage: false });
  try {
    assert.equal(rowActions(restricted.host).length, 0);
  } finally { await restricted.close(); }

  for (const status of [409, 412]) {
    const blocked = await mount({ archived: true, mutationFailure: {
      status, message: "Proposal cannot be deleted.", payload: { message: "Proposal cannot be deleted.", blockers: ["Delivery exists", { reason: "Inventory is reserved" }] },
    } });
    try {
      await showArchived(blocked);
      const listFetchesBeforeConflict = blocked.calls.filter(call => call.method === "GET").length;
      await click([...rowActions(blocked.host)].find(button => button.textContent.includes("Delete permanently")));
      await settle();
      assert.match(blocked.host.querySelector('[role="alert"]').textContent, /Proposal cannot be deleted.*Delivery exists.*Inventory is reserved/);
      assert.ok(blocked.calls.filter(call => call.method === "GET").length > listFetchesBeforeConflict, `list was refreshed following a ${status} conflict`);
      assert.equal(blocked.client.getQueryCache().find({ queryKey: ["sales-quote", "proposal-17"] }), undefined, "quote editor cache was cleared");
    } finally { await blocked.close(); }
  }
});
