import test, { after } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<html><body></body></html>", { url: "https://isolated.example.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "DocumentFragment", "MutationObserver", "Event", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
after(() => dom.window.close());

const built = await build({
  stdin: { resolveDir: process.cwd(), contents: 'export { LinesEditor, QuotesList, normalizeQuote, ticketLineError } from "./client/src/components/sales/QuotesWorkspace.jsx"; export { default as PublicSalesQuote } from "./client/src/pages/PublicSalesQuote.jsx"; export { default as BundleTaxOverride } from "./client/src/pages/sales/BundleTaxOverride.jsx";', loader: "js" },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  alias: { "@": `${process.cwd()}/client/src`, "@shared": `${process.cwd()}/shared` },
  plugins: [{
    name: "isolated-quote-tax",
    setup(builder) {
      builder.onResolve({ filter: /hooks\/useSalesSettings$/ }, () => ({ path: "naming", namespace: "fixture" }));
      builder.onResolve({ filter: /pages\/sales\/useCatalogue$/ }, () => ({ path: "tax", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        contents: path === "naming"
          ? 'export const useQuoteNaming=()=>({singular:"Quote",plural:"Quotes",slug:"quotes"});'
          : "export const useCatalogueTaxOptions=()=>({data:globalThis.quoteTaxFixture,isPending:false,isError:false});",
        loader: "js",
      }));
    },
  }],
});

test("direct Ticket editor adds a non-catalogue line with one description, manual pricing and provider tax", async () => {
  const zero = { provider: "xero", id: "ZERO", name: "Zero rated sales", rateBps: 0, selectable: true };
  globalThis.quoteTaxFixture = { provider: "xero", items: [zero] };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let current;
  let changeForm;
  function Fixture({ readOnly = false, canOverride = false }) {
    const [form, setForm] = React.useState({ currency: "GBP", lines: [] });
    current = form; changeForm = setForm;
    return React.createElement(mod.exports.LinesEditor, { form, setForm, products: [], bundles: [], readOnly, canOverride });
  }
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const render = props => root.render(React.createElement(QueryClientProvider, { client: cache }, React.createElement(Fixture, props)));
  try {
    await act(async () => render({}));
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Ticket").click());
    assert.equal(current.lines[0].type, "ticket");
    assert.equal(current.lines[0].productId, "");
    assert.equal(current.lines[0].bundleId, "");
    assert.match(host.textContent, /Ticket selection/);
    assert.equal(host.querySelectorAll('input[placeholder="Description"]').length, 1);
    assert.equal(host.querySelector('[aria-label="Line description"]'), null);
    assert.equal(host.querySelector('input[type="number"]').min, "1");
    assert.equal(host.querySelector('input[type="number"]').step, "1");
    assert.equal(host.querySelector('[aria-label="Line 1 standard price"]').disabled, false);
    assert.equal(host.querySelector('[aria-label="Line 1 quoted price"]').disabled, true);
    assert.equal(host.querySelector('input[max="100"]').disabled, true);
    assert.match(host.textContent, /Choose a ticket event and ticket type/);
    await act(async () => {
      const input = host.querySelector('input[placeholder="Description"]');
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, "Negotiated forum places");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(current.lines[0].description, "Negotiated forum places");
    const select = host.querySelector('[aria-label="Line 1 provider VAT code"]');
    await act(async () => {
      select.value = JSON.stringify(["xero", zero.id]);
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(current.lines[0].taxCode.id, zero.id);
    assert.equal(current.lines[0].taxChanged, true);
    await act(async () => {
      const input = host.querySelector('[aria-label="Line 1 standard price"]');
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, "87.50");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(current.lines[0].standardUnitPriceMinorInput, "87.50");
    assert.equal(current.lines[0].quotedUnitPriceMinorInput, "87.50");
    await act(async () => render({ canOverride: true }));
    assert.equal(host.querySelector('[aria-label="Line 1 quoted price"]').disabled, false);
    await act(async () => render({ readOnly: true }));
    assert.equal(host.querySelector('[aria-label="Line 1 standard price"]').disabled, true);
    assert.equal(host.querySelector('input[placeholder="Description"]').disabled, true);
    await act(async () => {
      changeForm(old => ({ ...old, lines: [{ ...old.lines[0], type: "free_text", quantity: "1.25" }] }));
      render({});
    });
    assert.equal(host.querySelector('input[type="number"]').step, "0.01");
  } finally {
    await act(async () => root.unmount()); cache.clear(); host.remove(); delete globalThis.quoteTaxFixture;
  }
});

test("ticket validation requires a complete typed reference and positive whole quantity without restricting free text", () => {
  const { ticketLineError } = mod.exports;
  const line = { type: "ticket", quantity: "3", eventReference: { kind: "complex", eventId: "forum", ticketTypeId: "team" } };
  assert.equal(ticketLineError(line), "");
  assert.equal(ticketLineError({ ...line, eventReference: { ...line.eventReference, kind: "simple" } }), "");
  for (const quantity of ["", "0", "-1", "1.5", "NaN", "Infinity"]) {
    assert.match(ticketLineError({ ...line, quantity }), /positive whole number/);
    assert.match(ticketLineError({ ...line, type: "product", quantity }), /positive whole number/);
  }
  for (const eventReference of [null, {}, { ...line.eventReference, kind: "other" }, { ...line.eventReference, ticketTypeId: "" }]) {
    assert.match(ticketLineError({ ...line, eventReference }), /Choose a ticket event and ticket type/);
  }
  assert.equal(ticketLineError({ type: "free_text", quantity: "1.25" }), "");
  assert.equal(ticketLineError({ type: "product", quantity: "1.25", eventReference: null }), "");
});

test("direct ticket normalization preserves explicit references and falls back to historical snapshots", () => {
  const explicit = { kind: "complex", eventId: "forum", ticketTypeId: "team" };
  const historical = { event_reference_kind: "simple", event_id: "previous", ticket_type_id: "pass" };
  const lines = mod.exports.normalizeQuote({ currentVersion: { lines: [
    { kind: "ticket", catalogueId: null, description: "Agreed places", quantity: "3", standardUnitPriceMinor: 8750, quotedUnitPriceMinor: 8125, eventReference: explicit, catalogue_snapshot: historical },
    { catalogue_kind: "ticket", catalogue_id: null, description: "Saved places", quantity: "2", standard_unit_price_minor: 9375, quoted_unit_price_minor: 8875, catalogue_snapshot: historical },
    { kind: "ticket", eventReference: null, catalogue_snapshot: historical },
  ] } }).lines;
  assert.equal(lines[0].type, "ticket");
  assert.deepEqual(lines[0].eventReference, explicit);
  assert.equal(lines[0].description, "Agreed places");
  assert.equal(lines[0].standardUnitPriceMinor, 8750);
  assert.equal(lines[0].quotedUnitPriceMinor, 8125);
  assert.equal(lines[1].type, "ticket");
  assert.deepEqual(lines[1].eventReference, { kind: "simple", eventId: "previous", ticketTypeId: "pass" });
  assert.equal(lines[1].standardUnitPriceMinor, 9375);
  assert.equal(lines[1].quotedUnitPriceMinor, 8875);
  assert.equal(lines[2].eventReference, null);
});

const mixedLines = () => [
  { key: "standard", type: "free_text", description: "Workshop delivery", quantity: "2.5",
    standardUnitPriceMinor: 1235, quotedUnitPriceMinor: 1235, discountBps: 1250, taxRateBps: 2000,
    taxCode: { provider: "xero", id: "PRIVATE-STANDARD", name: "Standard sales VAT", rateBps: 2000 },
    net_minor: 2701, tax_minor: 539, gross_minor: 3240 },
  { key: "zero", type: "free_text", description: "Printed resources", quantity: "3",
    standardUnitPriceMinor: 845, quotedUnitPriceMinor: 845, discountBps: 1000, taxRateBps: 0,
    taxCode: { provider: "xero", id: "PRIVATE-ZERO", name: "Zero rated sales", rateBps: 0 },
    net_minor: 2283, tax_minor: 0, gross_minor: 2283 },
  { key: "exempt", type: "free_text", description: "Exempt service", quantity: "1.25",
    standardUnitPriceMinor: 199, quotedUnitPriceMinor: 199, discountBps: 0, taxRateBps: 0,
    taxCode: { provider: "xero", id: "PRIVATE-EXEMPT", name: "Exempt income", rateBps: 0 },
    net_minor: 249, tax_minor: 0, gross_minor: 249 },
];

test("mounted draft previews use calculator rounding, quantity and discounts; readonly uses snapshots", async () => {
  globalThis.quoteTaxFixture = { items: [] };
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const form = { currency: "GBP", lines: mixedLines() };
  const props = { form, setForm() {}, products: [], bundles: [], canOverride: true };
  try {
    await act(async () => root.render(React.createElement(mod.exports.LinesEditor, { ...props, readOnly: false })));
    const breakdowns = () => [...host.querySelectorAll("dl")].map(dl => [...dl.querySelectorAll("dd")].map(dd => dd.textContent));
    assert.deepEqual(breakdowns(), [
      ["£27.03", "£5.41", "£32.44"],
      ["£22.83", "£0.00", "£22.83"],
      ["£2.49", "£0.00", "£2.49"],
    ]);
    assert.match(host.textContent, /Quoted unit net/);
    await act(async () => root.render(React.createElement(mod.exports.LinesEditor, { ...props, readOnly: true })));
    assert.deepEqual(breakdowns()[0], ["£27.01", "£5.39", "£32.40"]);
    assert.match(host.textContent, /Zero rated sales/);
    assert.match(host.textContent, /Exempt income/);
    assert.doesNotMatch(host.textContent, /PRIVATE-/);
  } finally {
    await act(async () => root.unmount()); host.remove(); delete globalThis.quoteTaxFixture;
  }
});

test("bundle VAT dropdown shows provider names, supports zero-rate selection and clearing", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let selected;
  const code = { id: "EXEMPT", name: "Exempt income", rateBps: 0, selectable: true };
  function Harness() {
    const [value, setValue] = React.useState({ provider: "xero", id: "OLD", name: "Saved VAT", rateBps: 500 });
    return React.createElement(mod.exports.BundleTaxOverride, { value, onChange: next => { selected = next; setValue(next); },
      taxOptions: { data: { provider: "xero", items: [code] }, isPending: false, isError: false } });
  }
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const select = host.querySelector('[aria-label="Bundle VAT override"]');
    assert.match(select.selectedOptions[0].textContent, /Saved VAT.*unavailable/);
    assert.match(host.textContent, /ignoring all included products/);
    const currentOption = [...select.options].find(option => option.textContent === "Exempt income");
    assert.ok(currentOption);
    await act(async () => { select.value = currentOption.value; select.dispatchEvent(new window.Event("change", { bubbles: true })); });
    assert.equal(selected.id, "EXEMPT");
    assert.equal(selected.provider, "xero");
    assert.equal(selected.rateBps, 0);
    await act(async () => { select.value = ""; select.dispatchEvent(new window.Event("change", { bubbles: true })); });
    assert.equal(selected, null);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("a selected bundle override is displayed instead of manual line tax selection", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let current;
  const code = { provider: "xero", id: "STANDARD", name: "Bundle VAT", rateBps: 2000 };
  function Harness() {
    const [form, setForm] = React.useState({ currency: "GBP", lines: [{ key: "bundle", type: "bundle",
      bundleId: "bundle-new", quantity: 1, standardUnitPriceMinor: 10000, quotedUnitPriceMinor: 10000,
      taxCode: code, taxRateBps: 2000, discountBps: 0 }] });
    current = form;
    return React.createElement(mod.exports.LinesEditor, { form, setForm, products: [],
      bundles: [{ id: "bundle-new", name: "Bundle", sellingPriceMinor: 10000, taxOverride: code }], readOnly: false, canOverride: true });
  }
  try {
    await act(async () => root.render(React.createElement(Harness)));
    assert.deepEqual(current.lines[0].taxCode, code);
    assert.equal(current.lines[0].taxRateBps, 2000);
    assert.equal(host.querySelector('[aria-label="Line 1 provider VAT code"]'), null);
    assert.match(host.textContent, /Bundle VAT/);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("mounted list and customer table show saved Net, Tax/VAT, Gross without repricing", async () => {
  const snapshot = {
    version_number: 2, currency: "GBP", lines: mixedLines(),
    totals: { netMinor: 9876, taxMinor: 321, grossMinor: 10197 },
  };
  const quote = { id: "quote-financial", quote_number: "Q-2026-0187", status: "issued", currentVersion: snapshot };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  cache.setQueryData(["sales-quotes", "", "all", 1, "", false], { items: [quote] });
  cache.setQueryData(["public-sales-quote", "fixture"], { quote, tenant: { name: "Association Learning" } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const wrap = child => React.createElement(QueryClientProvider, { client: cache },
    React.createElement(MemoryRouter, { initialEntries: ["/fixture"] }, child));
  try {
    await act(async () => root.render(wrap(React.createElement(mod.exports.QuotesList))));
    assert.deepEqual([...host.querySelectorAll("th")].slice(-4, -1).map(th => th.textContent), ["Net", "Tax/VAT", "Gross"]);
    assert.deepEqual([...host.querySelectorAll("tbody td")].slice(-4, -1).map(td => td.textContent), ["£98.76", "£3.21", "£101.97"]);
    await act(async () => root.render(wrap(React.createElement(Routes, null,
      React.createElement(Route, { path: "/:token", element: React.createElement(mod.exports.PublicSalesQuote) })))));
    assert.deepEqual([...host.querySelectorAll("th")].map(th => th.textContent),
      ["Description", "Qty", "Unit price (net)", "Discount", "Net", "Tax/VAT", "Gross"]);
    const rows = [...host.querySelectorAll("tbody tr")];
    assert.deepEqual([...rows[0].querySelectorAll("td")].slice(1).map(td => td.textContent),
      ["2.5", "£12.35", "12.5%", "£27.01", "£5.39", "£32.40"]);
    assert.match(rows[1].textContent, /Zero rated sales/);
    assert.match(rows[2].textContent, /Exempt income/);
    assert.match(host.textContent, /£98\.76/);
    assert.match(host.textContent, /£3\.21/);
    assert.match(host.textContent, /£101\.97/);
    assert.doesNotMatch(host.textContent, /PRIVATE-|£32\.44/);
  } finally {
    await act(async () => root.unmount()); host.remove(); cache.clear();
  }
});
const mod = new Module(`${process.cwd()}/quote-tax-labels-fixture.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
const { QueryClient, QueryClientProvider } = mod.require("@tanstack/react-query");
const { MemoryRouter, Routes, Route } = mod.require("react-router-dom");
mod._compile(built.outputFiles[0].text, `${process.cwd()}/quote-tax-labels-fixture.cjs`);

test("quote VAT options show only natural names and preserve identity when overridden", async () => {
  const standard = { provider: "xero", id: "PRIVATE-OUTPUT", name: "Standard sales VAT", rateBps: 2000, selectable: true };
  const zero = { provider: "xero", id: "PRIVATE-ZERO", name: "Zero rated sales", rateBps: 0, selectable: true };
  globalThis.quoteTaxFixture = { provider: "xero", items: [standard, zero, { id: "UNNAMED", rateBps: 725, selectable: false }] };
  let current;
  function Fixture() {
    const [form, setForm] = React.useState({ currency: "GBP", lines: [{
      key: "line", type: "free_text", description: "Workshop", quantity: 1,
      standardUnitPriceMinor: 1200, quotedUnitPriceMinor: 1200, discountBps: 0,
      taxCode: standard, taxRateBps: 2000,
    }] });
    current = form;
    return React.createElement(mod.exports.LinesEditor, { form, setForm, products: [], bundles: [], readOnly: false, canOverride: true });
  }
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(Fixture)));
    const select = host.querySelector('[aria-label="Line 1 provider VAT code"]');
    assert.deepEqual([...select.options].map(option => option.textContent), ["Standard sales VAT", "Standard sales VAT", "Zero rated sales", "VAT code unavailable"]);
    assert.equal(select.options[3].disabled, true);
    await act(async () => {
      select.value = JSON.stringify(["xero", zero.id]);
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(current.lines[0].taxCode.id, zero.id);
    assert.equal(current.lines[0].taxRateBps, 0);
    await act(async () => {
      select.value = "";
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(current.lines[0].taxCode.id, standard.id);
    assert.equal(current.lines[0].taxRateBps, 2000);
  } finally {
    await act(async () => root.unmount());
    host.remove(); delete globalThis.quoteTaxFixture;
  }
});
