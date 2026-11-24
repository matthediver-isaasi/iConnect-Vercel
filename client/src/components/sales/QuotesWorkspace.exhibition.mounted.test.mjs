import test, { after } from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<html><body></body></html>", { url: "https://isolated.example.test/sales/quotes/quote" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = createRequire(import.meta.url)("@tanstack/react-query");
const children = /\/(AmendQuoteButton|InvoiceStatusPanel|QuoteOpportunitySelect|QuoteEventSelect|QuoteLineTicketSelect|QuoteSalespersonSelect|QuoteContactSelect|SendQuoteDialog|AgreementLegalEditor|AgreementDocument|AgreementSignatureRequests|AgreementFinalizationPanel|AcceptQuoteButton|QuoteVersionDocuments|QuoteBillingSettings|BillingSchedule)$/;
const compiled = await build({
  entryPoints: ["client/src/components/sales/QuotesWorkspace.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  alias: { "@": `${process.cwd()}/client/src`, "@shared": `${process.cwd()}/shared` },
  plugins: [{ name: "quote-exhibition-boundaries", setup(builder) {
    builder.onResolve({ filter: /useSalesSettings$/ }, () => ({ path: "scope", namespace: "fixture" }));
    builder.onResolve({ filter: /^@\/hooks\/useSalesSettings$/ }, () => ({ path: "scope", namespace: "fixture" }));
    builder.onResolve({ filter: /^react-router-dom$/ }, () => ({ path: "router", namespace: "fixture" }));
    builder.onResolve({ filter: /\/useCatalogue$/ }, () => ({ path: "tax", namespace: "fixture" }));
    builder.onResolve({ filter: /\/useQuoteOpportunity$/ }, () => ({ path: "opportunity", namespace: "fixture" }));
    builder.onResolve({ filter: /^@\/api\/base44Client$/ }, () => ({ path: "api", namespace: "fixture" }));
    builder.onResolve({ filter: /^@\/components\/ui\// }, args => ({ path: args.path.endsWith("use-toast") ? "toast" : "ui", namespace: "fixture" }));
    builder.onResolve({ filter: children }, args => ({ path: args.path.endsWith("QuoteEventSelect") ? "event" : "child", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
      contents: {
        scope: 'export const useSalesSettingsScope=()=>({scopeKey:"tenant-test",ready:true}); export const useQuoteNaming=()=>({singular:"proposal",plural:"proposals"});',
        router: 'import React from "react"; export const useParams=()=>({id:"quote"}); export const useLocation=()=>({search:""}); export const useNavigate=()=>()=>{}; export const Link=({children})=><span>{children}</span>;',
        tax: 'export const useCatalogueTaxOptions=()=>globalThis.quoteExhibitionFixture.taxOptions || ({data:{items:[]},isPending:false,isError:false});',
        opportunity: 'export const useQuoteOpportunity=()=>globalThis.quoteExhibitionFixture.opportunity || {ready:true,contacts:[]}; export const opportunityContacts=()=>[]; export const clearOpportunityContacts=(form)=>form;',
        api: 'export const base44={_apiRequest:(...args)=>globalThis.quoteExhibitionFixture.json(...args)};',
        toast: 'export const useToast=()=>({toast:(value)=>globalThis.quoteExhibitionFixture.toasts.push(value)});',
        event: 'import React from "react"; export default function Event({disabled}){return <button disabled={disabled} aria-label="Event">Event</button>}',
        child: 'export default function Child(){return null} export const uniqueQuoteVersions=()=>[];',
        ui: `
          import React from "react";
          const Box=({children,...props})=><div {...props}>{children}</div>;
          export const Card=Box,CardContent=Box,CardHeader=Box,CardTitle=Box;
          export const Badge=({children})=><span>{children}</span>;
          export const Button=({children,variant,size,...props})=><button {...props}>{children}</button>;
          export const Input=props=><input {...props}/>;
          export const Textarea=props=><textarea {...props}/>;
          export const Label=props=><label {...props}/>;
          export const Tabs=({children})=><div>{children}</div>,TabsList=Tabs,TabsContent=Tabs,TabsTrigger=Tabs;
          export const Select=({children})=><div>{children}</div>,SelectTrigger=Select,SelectContent=Select,SelectItem=Select;
          export const SelectValue=()=>null;
        `,
      }[path], loader: "jsx", resolveDir: process.cwd(),
    }));
  } }],
});
const mod = new Module(`${process.cwd()}/quote-exhibition-save-fixture.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(compiled.outputFiles[0].text, `${process.cwd()}/quote-exhibition-save-fixture.cjs`);
const Workspace = mod.exports.default;
const lineId = "a13b462e-d457-478b-89d5-71b3c7e3f432";
const freshQuote = () => ({
  id: "quote", row_version: 7, status: "draft", permissions: { canEdit: true, canTransition: true },
  currentVersion: { version_number: 1, currency: "GBP", opportunity_id: "opportunity", notes: "Keep these customer notes", event_snapshot: { id: "event", kind: "simple" }, lines: [{
    id: lineId, catalogue_kind: "product", catalogue_id: "product", description: "Exhibitor stand", quantity: 1,
    standard_unit_price_minor: 17350, quoted_unit_price_minor: 17350, tax_rate_bps: 2000,
    catalogue_snapshot: { exhibition: { lineKey: "logical-not-db", slots: [{ key: "slot", lineUnit: 1, logicalLineId: "logical-not-db" }], selections: [{ slotKey: "slot", spaceId: "old", reference: "EX-17", priceMinor: 17350, currency: "GBP" }] } },
  }] },
});
const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
const click = async node => act(async () => node.click());
const button = (host, text) => [...host.querySelectorAll("button")].find(node => node.textContent === text);
async function mount(options = {}) {
  const state = { quote: freshQuote(), commands: [], toasts: [], failPatch: false, failReload: false, deferReload: false, ...options };
  let afterPatch = false;
  state.json = async (path, config = {}) => {
    if (path.includes("/exhibition?")) return { items: [{ id: "new", reference: "EX-21", price_minor: 21175, currency: "GBP", status: "available" }] };
    if (path.includes("/catalogue/")) return [];
    if (path.includes("resource=")) return { items: [] };
    if (config.method === "PATCH") {
      const command = JSON.parse(config.body);
      state.commands.push(command);
      if (state.failPatch) throw new Error("Space no longer available");
      afterPatch = true;
      state.quote.row_version++;
      state.quote.currentVersion.notes = command.notes;
      state.quote.currentVersion.lines = command.lines.map(payload => {
        const previous = state.quote.currentVersion.lines.find(line => line.id === payload.id);
        const next = { ...previous, description: payload.description, quantity: payload.quantity };
        if (state.regenerateLineIds) next.id = crypto.randomUUID();
        if (payload.exhibitionSelections !== undefined) {
          next.catalogue_snapshot = { ...previous.catalogue_snapshot, exhibition: { ...previous.catalogue_snapshot.exhibition, selections: payload.exhibitionSelections.map(item => ({ ...item, reference: item.spaceId === "new" ? "EX-21" : "EX-17", priceMinor: item.spaceId === "new" ? 21175 : 17350, currency: "GBP" })) } };
        }
        return next;
      });
      return structuredClone(state.quote);
    }
    if (config.method === "POST") {
      const command = { action: new URL(path, dom.window.location.origin).searchParams.get("action"), ...JSON.parse(config.body) };
      state.commands.push(command);
      if (state.onPost) { state.onPost(command, state); afterPatch = true; }
      return state.quote;
    }
    if (afterPatch && state.failReload) throw new Error("Reload connection failed");
    if (afterPatch && state.deferReload && path === "/api/sales/quotes/quote") await new Promise(resolve => { state.finishReload = resolve; });
    return structuredClone(state.quote);
  };
  globalThis.quoteExhibitionFixture = state;
  globalThis.fetch = async (path, config = {}) => {
    try { const data = await state.json(path, config); return { ok: true, status: 200, json: async () => data }; }
    catch (error) { return { ok: false, status: 409, json: async () => ({ message: error.message }) }; }
  };
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Workspace))));
  await settle(); await settle();
  return { host, state, close: async () => { await act(async () => root.unmount()); client.clear(); host.remove(); } };
}
async function replace(fixture) {
  await click(button(fixture.host, "Replace space")); await settle();
  const select = fixture.host.querySelector('select[aria-label="Space for slot slot"]');
  await act(async () => { select.value = "new"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
}

test("saved direct tickets roundtrip negotiated prices, description, reference and tax without a catalogue item", async () => {
  const quote = freshQuote();
  const reference = { kind: "complex", eventId: "learning-forum", ticketTypeId: "team-pass" };
  quote.currentVersion.lines = [{
    id: lineId, catalogue_kind: "ticket", catalogue_id: null, description: "Negotiated team places",
    quantity: "3", standard_unit_price_minor: 8750, quoted_unit_price_minor: 8125, discount_bps: 375,
    tax_rate_bps: 2000, catalogue_snapshot: {
      event_reference_kind: reference.kind, event_id: reference.eventId, ticket_type_id: reference.ticketTypeId,
      tax_code: { provider: "xero", id: "OUTPUT", name: "Standard sales VAT", rateBps: 2000 },
    },
  }];
  const fixture = await mount({ quote });
  try {
    const save = button(fixture.host, "Save draft");
    assert.equal(save.disabled, false);
    await click(save); await settle();
    const line = fixture.state.commands[0].lines[0];
    assert.equal(line.kind, "ticket");
    assert.equal(line.catalogueId, null);
    assert.equal(line.description, "Negotiated team places");
    assert.equal(line.quantity, "3");
    assert.equal(line.standardUnitPriceMinor, 8750);
    assert.equal(line.quotedUnitPriceMinor, 8125);
    assert.equal(line.discountBps, 375);
    assert.deepEqual(line.eventReference, reference);
    assert.deepEqual(line.taxCode, { provider: "xero", id: "OUTPUT" });
    assert.equal(line.id, lineId);
  } finally { await fixture.close(); }
});

test("incomplete or fractional direct tickets cannot save or recalculate", async () => {
  for (const [quantity, eventReference] of [
    ["2", null],
    ["2", { kind: "simple", eventId: "event", ticketTypeId: "" }],
    ["1.5", { kind: "simple", eventId: "event", ticketTypeId: "pass" }],
  ]) {
    const quote = freshQuote();
    quote.currentVersion.lines = [{
      id: lineId, kind: "ticket", quantity, eventReference, description: "Negotiated places",
      standardUnitPriceMinor: 8750, quotedUnitPriceMinor: 8750, tax_rate_bps: 0,
    }];
    const fixture = await mount({ quote });
    try {
      assert.equal(button(fixture.host, "Save draft").disabled, true);
      assert.equal(button(fixture.host, "Recalculate").disabled, true);
      await click(button(fixture.host, "Save draft"));
      assert.equal(fixture.state.commands.length, 0);
      assert.match(fixture.host.textContent, /Choose a ticket event and ticket type|positive whole number/);
    } finally { await fixture.close(); }
  }
});

test("product ticket references and free-text standard prices remain in save payloads", async () => {
  const quote = freshQuote();
  const reference = { kind: "simple", eventId: "forum", ticketTypeId: "individual" };
  quote.currentVersion.lines = [
    { id: lineId, kind: "product", catalogueId: "ticket-product", eventReference: reference, description: "Catalogue pass", quantity: "2", standardUnitPriceMinor: 9375, quotedUnitPriceMinor: 9375, tax_rate_bps: 0 },
    { kind: "free_text", description: "Workshop support", quantity: "1.25", standardUnitPriceMinor: 7125, quotedUnitPriceMinor: 6875, tax_rate_bps: 0 },
  ];
  const fixture = await mount({ quote });
  try {
    await click(button(fixture.host, "Save draft")); await settle();
    const [product, custom] = fixture.state.commands[0].lines;
    assert.deepEqual(product.eventReference, reference);
    assert.equal(product.catalogueId, "ticket-product");
    assert.equal(custom.standardUnitPriceMinor, 7125);
    assert.equal(custom.quotedUnitPriceMinor, 6875);
    assert.equal(custom.quantity, "1.25");
    assert.equal(Object.hasOwn(custom, "eventReference"), false);
  } finally { await fixture.close(); }
});
test("issued proposal without an active link never submits revocation", async () => {
  const quote = freshQuote();
  quote.status = "issued";
  quote.currentVersion.status = "issued";
  quote.hasActiveDeliveryLink = false;
  const fixture = await mount({ quote });
  try {
    assert.equal(button(fixture.host, "Revoke link").disabled, true);
    await click(button(fixture.host, "Revoke link"));
    assert.equal(fixture.state.commands.length, 0);
    assert.match(fixture.host.textContent, /No active customer link/);
    assert.match(fixture.host.querySelector('[aria-current="step"]').textContent, /Ready to send/);
  } finally { await fixture.close(); }
});

test("revocation remains busy through authoritative refresh and then disables the revoked link", async () => {
  const quote = freshQuote();
  quote.status = "sent";
  quote.currentVersion.status = "sent";
  quote.hasActiveDeliveryLink = true;
  const fixture = await mount({
    quote, deferReload: true,
    onPost(command, state) {
      assert.equal(command.action, "revoke");
      state.quote.hasActiveDeliveryLink = false;
    },
  });
  try {
    assert.equal(button(fixture.host, "Revoke link").disabled, false);
    await click(button(fixture.host, "Revoke link")); await settle();
    assert.deepEqual(fixture.state.commands, [{ action: "revoke", version: 1 }]);
    assert.equal(button(fixture.host, "Revoke link").disabled, true);
    assert.equal(fixture.host.querySelector("fieldset").disabled, true);
    await act(async () => fixture.state.finishReload()); await settle(); await settle();
    assert.equal(fixture.host.querySelector("fieldset").disabled, false);
    assert.equal(button(fixture.host, "Revoke link").disabled, true);
    assert.match(fixture.host.textContent, /No active customer link/);
    assert.match(fixture.host.querySelector('[aria-current="step"]').textContent, /Awaiting customer/);
  } finally { await fixture.close(); }
});

test("failed metadata refresh cannot leave a stale active link enabled", async () => {
  const quote = freshQuote();
  quote.status = "sent";
  quote.currentVersion.status = "sent";
  quote.hasActiveDeliveryLink = true;
  const fixture = await mount({ quote, failReload: true, onPost() {} });
  try {
    await click(button(fixture.host, "Revoke link")); await settle(); await settle();
    assert.equal(button(fixture.host, "Revoke link").disabled, true);
    assert.match(fixture.host.textContent, /Active link status could not be verified/);
  } finally { await fixture.close(); }
});

after(() => { globalThis.fetch = originalFetch; delete globalThis.quoteExhibitionFixture; dom.window.close(); });

test("picker persists full draft, expected version and saved line identity; remains busy until authoritative reload", async () => {
  const fixture = await mount({ deferReload: true });
  try {
    assert.equal(fixture.host.querySelector('[aria-label="Event"]').disabled, true);
    await replace(fixture);
    assert.equal(fixture.state.commands.length, 1);
    const command = fixture.state.commands[0];
    assert.equal(command.expectedVersion, 7);
    assert.equal(command.notes, "Keep these customer notes");
    assert.deepEqual(command.event, { id: "event", kind: "simple" });
    assert.equal(command.lines[0].id, lineId);
    assert.deepEqual(command.lines[0].exhibitionSelections, [{ slotKey: "slot", spaceId: "new" }]);
    assert.match(fixture.host.textContent, /EX-17/);
    assert.equal(fixture.host.querySelector("fieldset").disabled, true);
    assert.ok(!fixture.state.toasts.some(item => item.title === "Exhibition spaces saved"));
    await act(async () => { fixture.state.deferReload = false; fixture.state.finishReload(); }); await settle();
    assert.match(fixture.host.textContent, /EX-21/);
    assert.match(fixture.host.textContent, /£211\.75/);
    assert.equal(fixture.host.querySelector("fieldset").disabled, false);
    assert.ok(fixture.state.toasts.some(item => item.title === "Exhibition spaces saved"));
  } finally { await fixture.close(); }
});

test("rejected replacement keeps server selection and does not report success", async () => {
  const fixture = await mount({ failPatch: true });
  try {
    await replace(fixture); await settle();
    assert.match(fixture.host.textContent, /EX-17/);
    assert.match(fixture.host.textContent, /Space no longer available/);
    assert.ok(!fixture.state.toasts.some(item => item.title === "Exhibition spaces saved"));
  } finally { await fixture.close(); }
});

test("PATCH success followed by reload failure retains old selection and freezes further writes until retry reload", async () => {
  const fixture = await mount({ failReload: true });
  try {
    await replace(fixture); await settle();
    assert.match(fixture.host.textContent, /EX-17/);
    assert.match(fixture.host.textContent, /Previous values are shown/);
    assert.equal(fixture.host.querySelector("fieldset").disabled, true);
    fixture.state.failReload = false;
    await click(button(fixture.host, "Reload saved proposal")); await settle();
    assert.match(fixture.host.textContent, /EX-21/);
    assert.equal(fixture.host.querySelector("fieldset").disabled, false);
  } finally { await fixture.close(); }
});

test("held-line deletion is durable and keeps the line on rejected save", async () => {
  const fixture = await mount({ failPatch: true });
  const originalConfirm = dom.window.confirm;
  dom.window.confirm = () => true;
  try {
    await click(fixture.host.querySelector('[aria-label="Delete line 1"]')); await settle();
    assert.deepEqual(fixture.state.commands[0].lines, []);
    assert.match(fixture.host.textContent, /EX-17/);
    fixture.state.failPatch = false;
    await click(fixture.host.querySelector('[aria-label="Delete line 1"]')); await settle();
    assert.doesNotMatch(fixture.host.textContent, /EX-17/);
    assert.match(fixture.host.textContent, /No lines yet/);
  } finally { dom.window.confirm = originalConfirm; await fixture.close(); }
});

test("release persists an explicit empty selection list and unlocks Event only after reload", async () => {
  const fixture = await mount();
  try {
    await click(button(fixture.host, "Release")); await settle();
    assert.deepEqual(fixture.state.commands[0].lines[0].exhibitionSelections, []);
    assert.match(fixture.host.textContent, /No space selected/);
    assert.equal(fixture.host.querySelector('[aria-label="Event"]').disabled, false);
  } finally { await fixture.close(); }
});

test("dirty draft locks selection; saving preserves edits and omission of selections preserves server holds", async () => {
  const fixture = await mount();
  try {
    const notes = fixture.host.querySelector("textarea");
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(notes, "Edited without losing the stand");
      notes.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(button(fixture.host, "Replace space").disabled, true);
    assert.equal(button(fixture.host, "Release").disabled, true);
    assert.match(fixture.host.textContent, /Save your edits before choosing/);
    await click(button(fixture.host, "Save draft")); await settle();
    assert.equal(fixture.state.commands[0].notes, "Edited without losing the stand");
    assert.equal(Object.hasOwn(fixture.state.commands[0].lines[0], "exhibitionSelections"), false);
    assert.match(fixture.host.textContent, /EX-17/);
    assert.equal(button(fixture.host, "Replace space").disabled, false);
    await replace(fixture); await settle();
    assert.equal(fixture.state.commands[1].expectedVersion, 8);
    assert.equal(fixture.state.commands[1].notes, "Edited without losing the stand");
  } finally { await fixture.close(); }
});

test("cancel and reopen pass expectedVersion and accepted/converted proposals never expose these actions", async () => {
  const originalConfirm = dom.window.confirm;
  dom.window.confirm = () => true;
  try {
    for (const status of ["draft", "declined", "expired", "accepted", "converted"]) {
      const quote = freshQuote(); quote.status = status;
      const fixture = await mount({ quote });
      try {
        if (["accepted", "converted"].includes(status)) {
          assert.equal(button(fixture.host, "Cancel proposal"), undefined);
          assert.equal(button(fixture.host, "Reopen proposal"), undefined);
        } else {
          await click(button(fixture.host, status === "draft" ? "Cancel proposal" : "Reopen proposal")); await settle();
          assert.deepEqual(fixture.state.commands[0], { action: status === "draft" ? "exhibition-cancel" : "exhibition-reopen", expectedVersion: 7 });
        }
      } finally { await fixture.close(); }
    }
  } finally { dom.window.confirm = originalConfirm; }
});

test("bundle survives ordinary-line removal and subsequent saves use reloaded line IDs", async () => {
  const quote = freshQuote();
  const bundle = quote.currentVersion.lines[0];
  bundle.catalogue_kind = "bundle";
  bundle.catalogue_id = "bundle";
  bundle.sales_quote_bundle_component = [{ product_snapshot: { name: "Stand" }, quantity: 1 }];
  quote.currentVersion.lines.push({
    id: "f13b462e-d457-478b-89d5-71b3c7e3f432", catalogue_kind: "free_text",
    description: "Ordinary line", quantity: 1, standard_unit_price_minor: 100,
    quoted_unit_price_minor: 100, tax_rate_bps: 0,
  });
  const fixture = await mount({ quote, regenerateLineIds: true });
  try {
    await click(fixture.host.querySelector('[aria-label="Delete line 2"]'));
    await click(button(fixture.host, "Save draft")); await settle();
    assert.equal(fixture.state.commands[0].lines.length, 1);
    assert.equal(fixture.state.commands[0].lines[0].id, lineId);
    const reloadedId = fixture.state.quote.currentVersion.lines[0].id;
    assert.notEqual(reloadedId, lineId);
    assert.match(fixture.host.textContent, /EX-17/);
    await click(button(fixture.host, "Save draft")); await settle();
    assert.equal(fixture.state.commands[1].expectedVersion, 8);
    assert.equal(fixture.state.commands[1].lines[0].id, reloadedId);
    assert.equal(fixture.state.quote.currentVersion.lines[0].sales_quote_bundle_component.length, 1);
  } finally { await fixture.close(); }
});

function billingAddressQuote(status = "draft") {
  const quote = freshQuote();
  quote.status = status;
  quote.currentVersion.status = status;
  quote.currentVersion.address = {
    addressee: "Existing organisation",
    line1: "Old address line",
    line2: "Old suite",
    city: "Oldtown",
    region: "Oldshire",
    postalCode: "OT1 2AB",
    country: "United Kingdom",
  };
  return quote;
}

const structuredBillingOrganization = {
  id: "organization", name: "Northbank Members",
  invoicing_address_line1: "28 Willow Quay",
  invoicing_address_line2: "Floor 3",
  invoicing_city: "Bristol",
  invoicing_region: "Avon",
  invoicing_postal_code: "BS1 4QX",
  invoicing_country: "United Kingdom",
};

test("confirmed organisation invoice address replaces structured draft fields locally without saving", async () => {
  const quote = billingAddressQuote();
  const fixture = await mount({
    quote,
    opportunity: { ready: true, isSuccess: true, isPending: false, isFetching: false, data: { organization: structuredBillingOrganization }, contacts: [] },
  });
  const originalConfirm = dom.window.confirm;
  dom.window.confirm = message => {
    assert.match(message, /Replace this draft’s billing address/);
    assert.match(message, /local draft/);
    return true;
  };
  try {
    await click(button(fixture.host, "Use organisation invoice address")); await settle();
    assert.equal(fixture.host.querySelector('[aria-label="Addressee"]').value, "Northbank Members");
    assert.equal(fixture.host.querySelector('[aria-label="Address line 1"]').value, "28 Willow Quay");
    assert.equal(fixture.host.querySelector('[aria-label="Address line 2"]').value, "Floor 3");
    assert.equal(fixture.host.querySelector('[aria-label="City"]').value, "Bristol");
    assert.equal(fixture.host.querySelector('[aria-label="County / region"]').value, "Avon");
    assert.equal(fixture.host.querySelector('[aria-label="Postcode"]').value, "BS1 4QX");
    assert.equal(fixture.host.querySelector('[aria-label="Country"]').value, "United Kingdom");
    assert.equal(fixture.state.commands.length, 0);
  } finally { dom.window.confirm = originalConfirm; await fixture.close(); }
});

test("cancelling organisation address replacement leaves the local snapshot unchanged", async () => {
  const fixture = await mount({
    quote: billingAddressQuote(),
    opportunity: { ready: true, isSuccess: true, isPending: false, isFetching: false, data: { organization: structuredBillingOrganization }, contacts: [] },
  });
  const originalConfirm = dom.window.confirm;
  dom.window.confirm = () => false;
  try {
    await click(button(fixture.host, "Use organisation invoice address")); await settle();
    assert.equal(fixture.host.querySelector('[aria-label="Addressee"]').value, "Existing organisation");
    assert.equal(fixture.host.querySelector('[aria-label="Address line 1"]').value, "Old address line");
    assert.equal(fixture.host.querySelector('[aria-label="Address line 2"]').value, "Old suite");
    assert.equal(fixture.host.querySelector('[aria-label="City"]').value, "Oldtown");
    assert.equal(fixture.host.querySelector('[aria-label="County / region"]').value, "Oldshire");
    assert.equal(fixture.host.querySelector('[aria-label="Postcode"]').value, "OT1 2AB");
    assert.equal(fixture.host.querySelector('[aria-label="Country"]').value, "United Kingdom");
    assert.equal(fixture.state.commands.length, 0);
  } finally { dom.window.confirm = originalConfirm; await fixture.close(); }
});

test("issued read-only proposal cannot reload its billing address from the organisation", async () => {
  const fixture = await mount({
    quote: billingAddressQuote("issued"),
    opportunity: { ready: true, isSuccess: true, isPending: false, isFetching: false, data: { organization: structuredBillingOrganization }, contacts: [] },
  });
  try {
    assert.equal(button(fixture.host, "Use organisation invoice address"), undefined);
    assert.equal(fixture.host.querySelector('[aria-label="Address line 1"]').disabled, true);
    assert.equal(fixture.host.querySelector('[aria-label="Address line 1"]').value, "Old address line");
    assert.equal(fixture.state.commands.length, 0);
  } finally { await fixture.close(); }
});

test("new free-text lines display the sales default VAT and submit its provider identity", async () => {
  const code = { provider: "xero", id: "OUTPUT2", name: "Standard sales VAT", rateBps: 2000, selectable: true };
  const fixture = await mount({ taxOptions: { data: { provider: "xero", items: [code], defaultProductTaxCode: code }, isPending: false, isError: false } });
  try {
    await click(button(fixture.host, "Free text")); await settle();
    const select = fixture.host.querySelector('[aria-label="Line 2 provider VAT code"]');
    assert.equal(select.selectedOptions[0].textContent, code.name);
    await click(button(fixture.host, "Save draft")); await settle();
    assert.deepEqual(fixture.state.commands[0].lines[1].taxCode, { provider: "xero", id: code.id });
    assert.equal(fixture.state.commands[0].lines[0].taxRateBps, 2000);
  } finally { await fixture.close(); }
});

test("a free-text line added while VAT is loading gets the default when loading completes", async () => {
  const quote = freshQuote();
  quote.currentVersion.lines = [];
  const fixture = await mount({ quote, taxOptions: { isPending: true, isError: false } });
  try {
    await click(button(fixture.host, "Free text")); await settle();
    const code = { provider: "quickbooks", id: "7", name: "Zero rated sales", rateBps: 0, selectable: true };
    fixture.state.taxOptions = { data: { provider: "quickbooks", items: [code], defaultProductTaxCode: code }, isPending: false, isError: false };
    await click(button(fixture.host, "Free text")); await settle();
    for (const select of fixture.host.querySelectorAll('select[aria-label$="provider VAT code"]')) {
      assert.equal(select.selectedOptions[0].textContent, code.name);
    }
    await click(button(fixture.host, "Save draft")); await settle();
    assert.equal(fixture.state.commands[0].lines.length, 2);
    for (const line of fixture.state.commands[0].lines) assert.deepEqual(line.taxCode, { provider: "quickbooks", id: "7" });
  } finally { await fixture.close(); }
});

test("failed opportunity detail keeps the saved address and offers retry without saving or blanking it", async () => {
  let retries = 0;
  const fixture = await mount({
    quote: billingAddressQuote(),
    opportunity: {
      ready: false, isSuccess: false, isPending: false, isFetching: false, isError: true,
      error: new Error("Opportunity access denied"), refetch: () => { retries += 1; return Promise.resolve(); },
      contacts: [],
    },
  });
  try {
    assert.equal(button(fixture.host, "Use organisation invoice address").disabled, true);
    assert.match(fixture.host.textContent, /Could not load the opportunity’s organisation invoice details: Opportunity access denied/);
    assert.equal(fixture.host.querySelector('[aria-label="Address line 1"]').value, "Old address line");
    assert.equal(fixture.host.querySelector('[aria-label="City"]').value, "Oldtown");
    await click(button(fixture.host, "Retry loading"));
    assert.equal(retries, 1);
    assert.equal(fixture.state.commands.length, 0);
  } finally { await fixture.close(); }
});
