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
  stdin: { resolveDir: process.cwd(), contents: 'export { LinesEditor, QuotesList, normalizeQuote } from "./client/src/components/sales/QuotesWorkspace.jsx"; export { default as PublicSalesQuote } from "./client/src/pages/PublicSalesQuote.jsx";', loader: "js" },
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

test("mounted list and customer table show saved Net, Tax/VAT, Gross without repricing", async () => {
  const snapshot = {
    version_number: 2, currency: "GBP", lines: mixedLines(),
    totals: { netMinor: 9876, taxMinor: 321, grossMinor: 10197 },
  };
  const quote = { id: "quote-financial", quote_number: "Q-2026-0187", status: "issued", currentVersion: snapshot };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  cache.setQueryData(["sales-quotes", "", "all", 1, ""], { items: [quote] });
  cache.setQueryData(["public-sales-quote", "fixture"], { quote, tenant: { name: "Association Learning" } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const wrap = child => React.createElement(QueryClientProvider, { client: cache },
    React.createElement(MemoryRouter, { initialEntries: ["/fixture"] }, child));
  try {
    await act(async () => root.render(wrap(React.createElement(mod.exports.QuotesList))));
    assert.deepEqual([...host.querySelectorAll("th")].slice(-3).map(th => th.textContent), ["Net", "Tax/VAT", "Gross"]);
    assert.deepEqual([...host.querySelectorAll("tbody td")].slice(-3).map(td => td.textContent), ["£98.76", "£3.21", "£101.97"]);
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
